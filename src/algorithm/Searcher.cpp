#include <algorithm>
#include <cstring>
#include <iostream>
#include <string_view>
#include <vector>

#ifdef USE_FLATMAP

#include "parallel-hashmap/parallel_hashmap/phmap.h"
template <typename K, typename V>
using HashMap = phmap::flat_hash_map<K, V>;

#else

#include <unordered_map>
template <typename K, typename V>
using HashMap = std::unordered_map<K, V>;

#endif

using namespace std;
using GramMap = HashMap<string_view, int16_t*>;

namespace Searcher {

struct Match {
    int start, end;
};

struct Token {
    string_view token;
    float score;
    vector<Match> matches;
};

// an indexed token contains an index/pointer to the array of unique tokens
// and also an index of this token in the original sentence that contains it
struct IndexedToken {
    union {
        int idx;
        Token* token;
    };
    int index;
};

struct Sentence {
    // view of _original
    string_view original;
    // the sentence in its original form
    const char* _original;
    // tokenized sentence
    vector<IndexedToken> tokens;
    // score for this sentence (computed after a search)
    float score;
    // matches for this sentence (computed after a search)
    vector<Match> matches;
    ~Sentence() {
        free((void*)_original);
    }
};

/**
 * represents an instance of FastSearcher
 * In theroy this can be written as a c++ class, 
 * but embind has higher code size/runtime overhead, so plain C-struct is used instead
*/
struct FastSearcher {
    int size;
    // array of pre-processed and tokenized sentences
    Sentence* sentences;
    // working window for computing results
    float* scoreWindow;
    int* indices;
    vector<Token> uniqueTokens;
};

void split(const char* sentence, vector<string_view>& result) {
    const char* it = sentence;
    while (*it != 0) {
        const char* tokenStart = it;
        while (*it != ' ' && *it != 0) it++;
        result.push_back({tokenStart, static_cast<string_view::size_type>(it - tokenStart)});
        // skip spaces
        while (*it == ' ' && *it != 0) it++;
    }
}

/**
 * The queryGram hashmap maps a string to an pointer into the frequency table, which indicates the frequency of the gram
 * 
 * Reason for an additional level of indirection is that we need to constantly restore the frequency table to its original values
 * 
 * Instead of copying the whole map, we just copy the frequency which is stored in a separate array
 * @returns a pointer to the frequency table, and its size
 * @note ptr to ptr+size is the table, ptr+size to ptr+size*2 is a copy of this table
*/
inline pair<int16_t*, int> constructQueryGrams(GramMap& queryGrams, string_view query, int gramLen) {
    int queryGramCount = query.size() - gramLen + 1;
    auto* freqCount = new int16_t[queryGramCount * 2]();
    auto* curPtr = freqCount;
    for (int j = 0; j < queryGramCount; j++) {
        auto& ptr = queryGrams[query.substr(j, gramLen)];
        if (ptr == nullptr) {
            ptr = curPtr++;
        }
        (*ptr)++;
    }
    // prepare a copy of this table
    memcpy(freqCount + queryGramCount, freqCount, queryGramCount * sizeof(int16_t));
    return {freqCount, queryGramCount};
}

/**
 * Adapted from [[https://github.com/aceakash/string-similarity]], with optimizations
 * MIT License
 */
float compareTwoStrings(const GramMap& bigrams, string_view first, string_view second) {
    int len1 = first.length(),
        len2 = second.length();
    if (!len1 && !len2) return 1;          // if both are empty strings
    if (!len1 || !len2) return 0;          // if only one is empty string
    if (first == second) return 1;         // identical
    if (len1 == 1 && len2 == 1) return 0;  // both are 1-letter strings
    if (len1 < 2 || len2 < 2) return 0;    // if either is a 1-letter string

    int intersectionSize = 0;
    for (int i = 0; i < len2 - 1; i++) {
        auto it = bigrams.find(second.substr(i, 2));

        if (it != bigrams.end() && *it->second > 0) {
            *it->second -= 1;
            intersectionSize++;
        }
    }
    return (2.0f * intersectionSize) / (len1 + len2 - 2.0f);
}

vector<string_view> splitBuffer;

/**
 * add a new match [start, end) to an end of the match array
 * merge it with the last match if it overlaps with it
*/
inline void addMatchNoOverlap(vector<Match>& matches, int start, int end) {
    if (matches.size() && matches.back().end >= start) {
        matches.back().end = end;
    } else {
        matches.push_back({start, end});
    }
}

extern "C" {

/**
 * get a FastSearcher instance pointer
 * @param sentences an array of NULL-terminated strings. They should be .trim(), .toLowerCase(), and probably with puncturations stripped beforehand
 * @param N ths length of sentences
*/
FastSearcher* getSearcher(const char** sentences, int N) {
    auto* searcher = new FastSearcher();
    searcher->size = N;
    searcher->indices = new int[N];
    searcher->sentences = new Sentence[N];
    auto& uniqueTokens = searcher->uniqueTokens;

    int maxTokenLen = 0;
    // map a token to an index in the uniqueTokens array
    HashMap<string_view, int> str2num(N * 2);
    for (int i = 0; i < N; i++) {
        const char* sentence = searcher->sentences[i]._original = sentences[i];
        const char* it = sentence;
        while (*it != 0) {
            const char* tokenStart = it;
            // skip token until we hit spaces
            while (*it != ' ' && *it != 0) it++;
            string_view token(tokenStart, it - tokenStart);

            auto [mit, success] = str2num.insert({token, uniqueTokens.size()});
            if (success)  // if new unique token, add it to unique token list
                uniqueTokens.push_back({token, 0.0f});
            // record the position of this token in the unique token list
            searcher->sentences[i].tokens.push_back({{mit->second}, static_cast<int>(tokenStart - sentence)});
            // skip spaces
            while (*it == ' ' && *it != 0) it++;
        }
        searcher->sentences[i].original = {sentence, static_cast<string_view::size_type>(it - sentence)};
        maxTokenLen = max(maxTokenLen, static_cast<int>(searcher->sentences[i].tokens.size()));
    }
    // free the string array, but not strings themselves
    free((void*)sentences);
    uniqueTokens.shrink_to_fit();
    searcher->scoreWindow = new float[maxTokenLen];

    // note: we can only assign pointers into uniqueTokens here (no reallocations will occur after this point)
    // otherwise they might be invalid
    for (int i = 0; i < N; i++) {
        for (auto& token : searcher->sentences[i].tokens) {
            token.token = &uniqueTokens[token.idx];
        }
    }
#ifdef DEBUG_LOG
    int numTokens = 0;
    for (int i = 0; i < N; i++) {
        numTokens += searcher->sentences[i].tokens.size();
    }
    cout << "num tokens: " << numTokens << " | num unique: " << uniqueTokens.size() << endl;
#endif
    return searcher;
}

/**
 * Adapted from [[https://github.com/aceakash/string-similarity]], with optimizations
 * MIT License
 * @param _query a dynamically allocated string. It will be freed before this function returns.
 */
int findBestMatch(FastSearcher* searcher, const char* _query) {
    string_view query(_query);
    GramMap queryGrams;
    auto [freqCount, queryGramCount] = constructQueryGrams(queryGrams, query, 2);

    float bestMatchRating = 0.0f;
    int bestMatchIndex = 0;
    for (int i = 0; i < searcher->size; i++) {
        float currentRating = compareTwoStrings(queryGrams, query, searcher->sentences[i].original);
        if (currentRating > bestMatchRating) {
            bestMatchIndex = i;
            bestMatchRating = currentRating;
        }
        memcpy(freqCount, freqCount + queryGramCount, queryGramCount * sizeof(int16_t));
    }
    searcher->sentences[bestMatchIndex].score = bestMatchRating;
    free((void*)_query);
    delete[] freqCount;
    return bestMatchIndex;
}

/**
 * sliding window search
 * @param _query a dynamically allocated string. It will be freed after this function returns.
*/
int* sWSearch(FastSearcher* searcher, const char* _query, const int numResults, const int gramLen, const float threshold) {
    string_view query(_query);
    splitBuffer.resize(0);
    split(_query, splitBuffer);

    int len = searcher->uniqueTokens.size();
    int maxWindow = max((int)splitBuffer.size(), 2);
    {
        GramMap queryGrams;
        auto [freqCount, queryGramCount] = constructQueryGrams(queryGrams, query, gramLen);

        // compute score and match for each unique token
        for (int i = 0; i < len; i++) {
            auto& token = searcher->uniqueTokens[i];
            const int tokenGramCount = static_cast<int>(token.token.size()) - gramLen + 1;
            if (tokenGramCount <= 0) {
                token.score = 0.0f;
                continue;
            }

            int intersectionSize = 0;
            token.matches.resize(0);  // clear previous matches
            for (int j = 0; j < tokenGramCount; j++) {
                auto it = queryGrams.find(token.token.substr(j, gramLen));
                if (it != queryGrams.end() && *(it->second) > 0) {
                    *it->second -= 1;  // decrement the frequency (don't want this gram to be matched again)
                    intersectionSize++;
                    addMatchNoOverlap(token.matches, j, j + gramLen);
                }
            }
            // intersection over union
            token.score = (2.0f * intersectionSize) / (queryGramCount + tokenGramCount);

            // restore frequency table to its original state
            memcpy(freqCount, freqCount + queryGramCount, queryGramCount * sizeof(int16_t));
        }
        delete[] freqCount;
    }

    len = searcher->size;
    // compute score and matches for each sentence
    for (int i = 0; i < len; i++) {
        auto& sentence = searcher->sentences[i];
        sentence.matches.resize(0);

        const int tokenLen = sentence.tokens.size();

        // use the number of words as the window size in this string if maxWindow > number of words
        const int window = min(maxWindow, tokenLen);

        float score = 0, maxScore = 0;
        // initialize score window
        for (int j = 0; j < window; j++) {
            auto token = sentence.tokens[j].token;
            score += searcher->scoreWindow[j] = token->score;

            if (token->score < threshold) continue;
            // add token matches to sentence matches
            for (auto match : token->matches)
                addMatchNoOverlap(sentence.matches, sentence.tokens[j].index + match.start, sentence.tokens[j].index + match.end);
        }
        if (score > maxScore) maxScore = score;

        for (int j = window; j < tokenLen; j++) {
            // subtract the last score and add the new score
            score -= searcher->scoreWindow[j - window];
            auto token = sentence.tokens[j].token;
            score += searcher->scoreWindow[j] = token->score;

            if (token->score < threshold) continue;
            if (score > maxScore) maxScore = score;

            // add token matches to sentence matches
            for (auto match : token->matches)
                addMatchNoOverlap(sentence.matches, sentence.tokens[j].index + match.start, sentence.tokens[j].index + match.end);
        }
        sentence.score = maxScore;
    }
    for (int i = 0; i < len; i++) {
        searcher->indices[i] = i;
    }
    if (len > numResults) {
        std::partial_sort(
            searcher->indices,
            searcher->indices + numResults, searcher->indices + len,
            [searcher](int a, int b) {
                return searcher->sentences[b].score < searcher->sentences[a].score;
            });
    } else {
        std::sort(
            searcher->indices,
            searcher->indices + len,
            [searcher](int a, int b) {
                return searcher->sentences[b].score < searcher->sentences[a].score;
            });
    }
    free((void*)_query);
    return searcher->indices;
}

const Match* getMatches(const FastSearcher* searcher, int idx) {
    return searcher->sentences[idx].matches.data();
}
int getMatchSize(const FastSearcher* searcher, int idx) {
    return searcher->sentences[idx].matches.size();
}
float getScore(const FastSearcher* searcher, int idx) {
    return searcher->sentences[idx].score;
}

void deleteSearcher(FastSearcher* searcher) {
    delete[] searcher->sentences;
    delete[] searcher->indices;
    delete[] searcher->scoreWindow;
    delete searcher;
}
}  // end extern "C"
}  // namespace Searcher

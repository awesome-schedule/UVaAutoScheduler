import { Searcher, SearchResult } from 'fast-fuzzy';
import Course, { CourseConstructorArguments } from '../models/Course';
import Section, { SectionMatch } from '../models/Section';

declare var postMessage: any;

let courseSearcher: Searcher<Course>;
let sectionSearcher: Searcher<Section>;
let courseDict: { [x: string]: Course };
let count = 0;

/**
 * initialize the worker using `msg.data` which is assumed to be a `courseDict` on the first message,
 * posting the string literal 'ready' as the response
 *
 * start fuzzy search using `msg.data` which is assumed to be a string for the following messages,
 * posting the array of tuples (used to construct [[Course]] instances) as the response
 */
onmessage = (msg: MessageEvent) => {
    if (count === 0) {
        console.time('worker prep');
        courseDict = msg.data;
        const courses = Object.values(courseDict);
        const sections: Section[] = [];
        for (const { sections: secs } of courses) sections.push(...secs);

        sectionSearcher = new Searcher(sections, {
            returnMatchData: true,
            ignoreCase: true,
            normalizeWhitespace: true,
            keySelector: obj => [obj.topic, obj.instructors.join(', ')]
        });
        courseSearcher = new Searcher(courses, {
            returnMatchData: true,
            ignoreCase: true,
            normalizeWhitespace: true,
            keySelector: obj => [obj.title, obj.description]
        });
        postMessage('ready');
        console.timeEnd('worker prep');
    } else {
        const query: string = msg.data;

        const courseResults = courseSearcher.search(query);
        const sectionResults = sectionSearcher.search(query);

        const courseScores: { [x: string]: number } = Object.create(null);
        const courseMap: { [x: string]: SearchResult<Course> } = Object.create(null);
        const sectionMap: { [x: string]: SearchResult<Section>[] } = Object.create(null);

        for (const result of courseResults) {
            const item = result.item;
            const key = item.key;
            courseScores[key] = result.score * (result.original === item.title ? 1 : 0.5);
            courseMap[key] = result;
        }

        for (const result of sectionResults) {
            const item = result.item;
            const key = item.key;
            const score = result.score * (result.original === item.topic ? 0.8 : 0.4);
            if (courseScores[key]) {
                courseScores[key] += score;
            } else {
                courseScores[key] = score;
            }
            if (sectionMap[key]) {
                sectionMap[key].push(result);
            } else {
                sectionMap[key] = [result];
            }
        }

        const scoreEntries = Object.entries(courseScores)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12);

        const finalResults: CourseConstructorArguments[] = [];
        for (const [key] of scoreEntries) {
            const courseMatch = courseMap[key];
            let course: CourseConstructorArguments;
            if (courseMatch) {
                const { match, original, item } = courseMatch;
                const combSecMatches: SectionMatch[][] = [];
                const s = sectionMap[key];
                if (s) {
                    const matchedSecIdx = s.map(x => x.item.sid);
                    const secMatches = s.map(x => [
                        {
                            match: x.original === x.item.topic ? 'topic' : 'instructors',
                            start: x.match.index,
                            end: x.match.index + x.match.length
                        } as SectionMatch
                    ]);
                    for (const sid of item.sids) {
                        const idx = matchedSecIdx.findIndex(x => x === sid);
                        if (idx === -1) {
                            combSecMatches.push([]);
                        } else {
                            combSecMatches.push(secMatches[idx]);
                        }
                    }
                }
                course = [
                    item.raw,
                    key,
                    item.sids,
                    [
                        {
                            match: original === item.title ? 'title' : 'description',
                            start: match.index,
                            end: match.index + match.length
                        }
                    ],
                    combSecMatches
                ];
            } else {
                const s = sectionMap[key];
                course = [
                    s[0].item.course.raw,
                    key,
                    s.map(x => x.item.sid),
                    [],
                    s.map(x => [
                        {
                            match: x.original === x.item.topic ? 'topic' : 'instructors',
                            start: x.match.index,
                            end: x.match.index + x.match.length
                        } as SectionMatch
                    ])
                ];
            }
            finalResults.push(course);
        }
        postMessage(finalResults);
    }
    count++;
};

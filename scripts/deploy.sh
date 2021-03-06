#!/bin/bash
set -e # Exit with nonzero exit code if anything fails

SOURCE_BRANCH="master"
TARGET_BRANCH="master"

function doCompile {
    cd scripts
    git clone https://github.com/awesome-schedule/data # clone and serve our data
    npx http-server -p 8000 --cors --silent &
    cd ..
    npm run getwasm
    npm run test
    npm run build
    npm run tsdoc # build our documentation
}

# Pull requests and commits to other branches shouldn't try to deploy, just build to verify
if [ "$TRAVIS_PULL_REQUEST" != "false" -o "$TRAVIS_BRANCH" != "$SOURCE_BRANCH" ]; then
    doCompile
    echo "Not from master. Skipping deploy."
    exit 0
fi

# Save some useful information
REPO="https://github.com/awesome-schedule/awesome-schedule.github.io.git"
SSH_REPO=${REPO/https:\/\/github.com\//git@github.com:}
SHA=`git rev-parse --verify HEAD`

# Clone the existing gh-pages for this repo into out/
# Create a new empty branch if gh-pages doesn't exist yet (should only happen on first deply)
# Delete all existing contents except .git (we will re-create them)
git clone $REPO out
cd out
git checkout $TARGET_BRANCH || git checkout --orphan $TARGET_BRANCH
find -maxdepth 1 ! -name .git ! -name . | xargs rm -rf
cd ..

# Run our compile script
doCompile

# copy some config files for github pages
cp public/.gitattributes out/
cp public/.nojekyll out/
cp public/CNAME out/

# copy to out
cp -rf dist/* out/

# copy generated documentation
mkdir -p out/docs/tsdoc
cp -rf docs/tsdoc/* out/docs/tsdoc/

# Now let's go have some fun with the cloned repo
cd out
git config --global user.name "Travis CI"
git config --global user.email "$COMMIT_AUTHOR_EMAIL"

# If there are no changes to the compiled out (e.g. this is a README update) then just bail.
if git diff --quiet; then
    echo "No changes to the output on this push; exiting."
    exit 0
fi

# Commit the "changes", i.e. the new version.
# The delta will show diffs between new and old versions.
git add -A .
git commit -m "Deploy to GitHub Pages: ${SHA}"

# Get the deploy key by using Travis's stored variables to decrypt deploy_key.enc
ENCRYPTED_KEY_VAR="encrypted_${ENCRYPTION_LABEL}_key"
ENCRYPTED_IV_VAR="encrypted_${ENCRYPTION_LABEL}_iv"
ENCRYPTED_KEY=${!ENCRYPTED_KEY_VAR}
ENCRYPTED_IV=${!ENCRYPTED_IV_VAR}
openssl aes-256-cbc -K $ENCRYPTED_KEY -iv $ENCRYPTED_IV -in ../scripts/deploy_key.enc -out ../scripts/deploy_key -d
chmod 600 ../scripts/deploy_key
eval `ssh-agent -s`
ssh-add ../scripts/deploy_key

# Now that we're all set up, we can push.
git push $SSH_REPO $TARGET_BRANCH
#!/bin/zsh
pwd=$(pwd)
trap 'cd "$pwd"; echo "Returned to $pwd"' EXIT INT
echo "Updating Custom Validations"

echo "Building a new config from build.yaml"
npm run start
echo "Done"
echo "Pasting environment string to env file"
envData=$(cat .env)
echo "$envData" > ./build-output/automation-api-service/.env
echo "Done"
echo "Installing node modules in build-output"
cd build-output/automation-api-service
npm install
echo "Done"
echo "Step 4: Building the project"
npm run dev

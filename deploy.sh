#!/bin/bash

# Biospex Individual Lambda Deployer (No-Dependency Mode)

DIR_NAME=$(basename "$PWD")
REGION="us-east-2"
S3_TEMP_BUCKET="biospex-loc"

echo ">>> Starting deployment for: $DIR_NAME"

# ------------------------------------------------------------------------------
# STEP 1: Building the Zip File
# ------------------------------------------------------------------------------
# Clean up any existing local zip files before building
if [ -f "function.zip" ]; then
    echo "Removing existing function.zip..."
    rm "function.zip"
fi

if [ -f "package.json" ]; then
    echo "[1/1] Node.js detected. Preparing function.zip..."
    ZIP_NAME="function.zip"
    # Match logic for BiospexBatchCreator: index.mjs node_modules package.json
    zip -r "$ZIP_NAME" index.mjs node_modules package.json
else
    echo "Error: No package.json found in $DIR_NAME"
    exit 1
fi

if [ $? -eq 0 ]; then
    echo "Successfully created $ZIP_NAME"
else
    echo "Error: Failed to create zip file"
    exit 1
fi

# ------------------------------------------------------------------------------
# STEP 2: Interactive Upload
# ------------------------------------------------------------------------------
echo ""
read -p "Step 2: Upload $ZIP_NAME to AWS? (y/n): " confirm_upload
if [[ "$confirm_upload" =~ ^[Yy]$ ]]; then
    FILESIZE=$(stat -c%s "$ZIP_NAME")
    if [ $FILESIZE -gt 50000000 ]; then
        echo "File size ($FILESIZE bytes) is large (>50MB). Using S3 bridge (bucket: $S3_TEMP_BUCKET)..."
        aws s3 cp "$ZIP_NAME" "s3://$S3_TEMP_BUCKET/$ZIP_NAME"
        aws lambda update-function-code --function-name "$DIR_NAME" \
            --s3-bucket "$S3_TEMP_BUCKET" --s3-key "$ZIP_NAME" --region $REGION
        aws s3 rm "s3://$S3_TEMP_BUCKET/$ZIP_NAME"
    else
        aws lambda update-function-code --function-name "$DIR_NAME" \
            --zip-file "fileb://$ZIP_NAME" --region $REGION
    fi
else
    echo "Upload skipped. Exiting."
    exit 0
fi

# ------------------------------------------------------------------------------
# STEP 3: Interactive Versioning
# ------------------------------------------------------------------------------
echo ""
read -p "Step 3: Create a new Lambda version? (y/n): " confirm_version
if [[ "$confirm_version" =~ ^[Yy]$ ]]; then
    read -p "Enter version description: " VERSION_DESC
    NEW_VERSION=$(aws lambda publish-version --function-name "$DIR_NAME" \
        --description "$VERSION_DESC" --query 'Version' --output text --region $REGION)
    echo "Successfully created version: $NEW_VERSION"
else
    echo "Versioning skipped. Done."
    exit 0
fi

# ------------------------------------------------------------------------------
# STEP 4: Interactive Aliases
# ------------------------------------------------------------------------------
echo ""
read -p "Step 4: Update aliases? (loc/dev/prod/all/n): " alias_choice
case "$alias_choice" in
    loc|dev|prod) TARGETS=("$alias_choice") ;;
    all) TARGETS=("loc" "dev" "prod") ;;
    *) echo "Alias update skipped. Done."; exit 0 ;;
esac

for ALIAS in "${TARGETS[@]}"; do
    echo "Updating alias '$ALIAS' to version $NEW_VERSION..."
    aws lambda update-alias --function-name "$DIR_NAME" --name "$ALIAS" \
        --function-version "$NEW_VERSION" --region $REGION 2>/dev/null || \
    aws lambda create-alias --function-name "$DIR_NAME" --name "$ALIAS" \
        --function-version "$NEW_VERSION" --region $REGION
done

echo ">>> Deployment of $DIR_NAME completed successfully."

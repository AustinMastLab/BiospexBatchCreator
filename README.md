# BiospexBatchCreator

## Purpose
Handles the logic for creating export batches (e.g., for Zooniverse). It takes a large archive (ZIP or TAR.GZ), extracts it, and splits it into smaller, manageable batches based on a CSV manifest.

## Workflow
1. **Trigger**: Receives messages from SQS.
2. **Extraction**: Downloads the source archive from S3 and extracts it to a local directory.
   - For very large archives, it uses Amazon EFS mount (`/efs/batch`) instead of `/tmp`.
3. **Batching**: Parses the manifest CSV and groups rows into batches (default size: 2000).
4. **ZIP Creation**: For each batch, it creates a new ZIP file containing:
   - A filtered `manifest.csv` containing only the rows for that batch.
   - The corresponding image files listed in the manifest.
5. **Upload**: Saves each batch ZIP to the `batch/` directory in S3.
6. **Callback**: Reports the list of created batch files and status back to Laravel via SQS.

## Inputs/Outputs
- **Inputs (JSON)**:
  - `downloadId`: ID of the download/export record in Laravel.
  - `file`: Filename of the source archive.
  - `exportPath`: S3 key of the source archive.
  - `totalSize`: Size of the archive (used to decide between `/tmp` and EFS).
  - `updatesQueueUrl`: SQS URL for status reporting.
  - `s3Bucket`: Target S3 bucket.
- **Outputs**:
  - S3: Batch ZIP files at `batch/{filename}-part{n}.zip`.
  - SQS: Success/Failure notification to `updatesQueueUrl`.

## Configuration (Environment Variables)
- `BATCH_SIZE`: Number of rows per batch (Default: `2000`).
- `EFS_PATH`: Local mount point for EFS (Default: `/efs/batch`).
- `MAX_TMP_SIZE`: Threshold in bytes to switch from `/tmp` to EFS (Default: `7516192768` / ~7GB).

## Related Components
- **Laravel Command**: `App\Console\Commands\SqsListenerBatchUpdate` (Listens for `success` status and `batchFiles` list).
- **Laravel Service**: `App\Services\Actor\Zooniverse\ZooniverseBatchTriggerService` (Typically triggers this process).

## Deployment
Use the `deploy.sh` script for interactive deployment to AWS (Region: `us-east-2`).

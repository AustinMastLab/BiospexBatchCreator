# BiospexBatchCreator

## Purpose
Splits a large finished export archive (ZIP or TAR.GZ, for example a Zooniverse export) into smaller batch ZIPs that users can download one at a time, based on its CSV manifest.

## Workflow
1. **Trigger**: Receives messages from the SQS queue `{prefix}-batch-trigger`. BIOSPEX sends them from `App\Jobs\ZooniverseExportDownloadBatchJob` when a user asks to download an export in batches (`App\Http\Controllers\Admin\DownloadController`).
2. **Extraction**: Downloads the source archive from S3 and extracts it to a local directory.
   - For very large archives, it uses Amazon EFS mount (`/efs/batch`) instead of `/tmp`.
3. **Batching**: Parses the manifest CSV and groups rows into batches (default size: 2000).
4. **ZIP Creation**: For each batch, it creates a new ZIP file containing:
   - A filtered `manifest.csv` containing only the rows for that batch.
   - The corresponding image files listed in the manifest.
5. **Upload**: Saves each batch ZIP to the `batch/` directory in S3.
6. **Callback**: Reports the list of created batch files and status back to BIOSPEX via SQS (`updatesQueueUrl`, the `{prefix}-batch-update` queue), with `function` set to `BiospexBatchCreator`.

This function is not part of the ZipBatchOrchestrator state machine, which builds export ZIPs; this one splits a finished export for download.

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
- **Laravel Job**: `App\Jobs\ZooniverseExportDownloadBatchJob` (sends the trigger message and starts the batch listener).
- **Laravel Command**: `App\Console\Commands\SqsListenerBatchUpdate` (`batch:listen`, receives the result).
- **Laravel Job**: `App\Jobs\ZooniverseExportBatchResultJob` (emails the project owner download links for each batch, valid for 72 hours).

## Deployment
Use the `deploy.sh` script for interactive deployment to AWS (Region: `us-east-2`).

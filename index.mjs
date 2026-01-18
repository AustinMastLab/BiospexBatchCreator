// @ts-nocheck
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import archiver from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import csvParser from 'csv-parser';
import AdmZip from 'adm-zip';
import { x as tarExtract } from 'tar';

const s3 = new S3Client();
const sqs = new SQSClient({ region: 'us-east-2' });

const MAX_TMP_SIZE = parseInt(process.env.MAX_TMP_SIZE) || (7 * 1024 * 1024 * 1024); // 7GB
const EFS_PATH = process.env.EFS_PATH || '/efs/batch';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 1000;

export const handler = async (event, context) => {
    const records = event.Records || (event.body ? [{ body: JSON.stringify(event) }] : []);

    try {
        for (const record of records) {
            let message;
            try {
                message = JSON.parse(record.body);
            } catch (parseError) {
                continue;
            }

            const { downloadId, file, exportPath, totalSize, updatesQueueUrl, s3Bucket } = message;

            if (!downloadId || !file || !exportPath || !updatesQueueUrl || !s3Bucket) {
                if (updatesQueueUrl && downloadId) {
                    await sendErrorMessage(updatesQueueUrl, downloadId, 'Missing required fields');
                }
                continue;
            }

            let workDir;
            try {
                const useEfs = totalSize > MAX_TMP_SIZE;
                workDir = useEfs ? path.join(EFS_PATH, `batch-${downloadId}`) : '/tmp';
                const batchFiles = [];

                if (useEfs) {
                    await fs.promises.mkdir(workDir, { recursive: true });
                }

                await downloadAndSplit(s3, message, workDir, batchFiles);

                if (batchFiles.length === 0) {
                    throw new Error('No batches created');
                }

                await sqs.send(new SendMessageCommand({
                    QueueUrl: updatesQueueUrl,
                    MessageBody: JSON.stringify({
                        downloadId,
                        function: 'BiospexBatchCreator',
                        status: 'success',
                        batchFiles,
                        totalBatches: batchFiles.length,
                    }),
                }));

            } catch (error) {
                console.error(`Batch failed for ${downloadId}:`, error.message);
                if (updatesQueueUrl && downloadId) {
                    await sendErrorMessage(updatesQueueUrl, downloadId, error.message);
                }
            } finally {
                if (workDir && workDir.startsWith(EFS_PATH)) {
                    try {
                        await fs.promises.rm(workDir, { recursive: true, force: true });
                    } catch (cleanupError) {
                        // ignore
                    }
                }
            }
        }
    } catch (globalError) {
        console.error('Global failure:', globalError.message);
    }
};

async function sendErrorMessage(queueUrl, downloadId, errorMessage) {
    try {
        await sqs.send(new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify({
                downloadId,
                function: 'BiospexBatchCreator',
                status: 'failed',
                error: errorMessage
            }),
        }));
    } catch (sqsError) {
        console.error('Failed to send error notification:', sqsError.message);
    }
}

async function downloadAndSplit(s3Client, msg, workDir, batchFiles) {
    const { file, exportPath, s3Bucket, downloadId } = msg;
    const localArchivePath = path.join(workDir, file);
    let extractDir;

    try {
        const { Body } = await s3Client.send(new GetObjectCommand({
            Bucket: s3Bucket,
            Key: exportPath,
        }));

        await pipeline(Body, fs.createWriteStream(localArchivePath));

        extractDir = path.join(workDir, 'extract');
        await fs.promises.mkdir(extractDir, { recursive: true });

        const ext = path.extname(file).toLowerCase();
        if (ext === '.zip') {
            const zip = new AdmZip(localArchivePath);
            const entries = zip.getEntries();
            for (const entry of entries) {
                if (!entry.isDirectory) {
                    const entryPath = path.join(extractDir, entry.entryName);
                    await fs.promises.mkdir(path.dirname(entryPath), { recursive: true });
                    await fs.promises.writeFile(entryPath, entry.getData());
                }
            }
        } else if (ext === '.gz' || file.endsWith('.tar.gz')) {
            await tarExtract({
                file: localArchivePath,
                cwd: extractDir,
                preservePaths: true,
            });
        }

        const extractedFiles = await fs.promises.readdir(extractDir);
        const csvFiles = extractedFiles.filter(f => f.toLowerCase().endsWith('.csv'));

        if (csvFiles.length === 0) throw new Error('No CSV file found');

        const originalCsvPath = path.join(extractDir, csvFiles[0]);
        const rows = [];

        await new Promise((resolve, reject) => {
            fs.createReadStream(originalCsvPath)
                .pipe(csvParser({ skipEmptyLines: true }))
                .on('data', (row) => {
                    if (Object.values(row).some(v => v)) rows.push(row);
                })
                .on('end', resolve)
                .on('error', reject);
        });

        if (rows.length === 0) throw new Error('CSV is empty');

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            const batch = rows.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const batchFileName = `${path.basename(file, path.extname(file))}-part${batchNum}.zip`;
            const batchZipPath = path.join(workDir, batchFileName);

            await createBatchZip(extractDir, batch, batchZipPath, s3Bucket, downloadId);
            batchFiles.push(batchFileName);
        }
    } finally {
        try {
            if (extractDir) await fs.promises.rm(extractDir, { recursive: true, force: true });
            if (fs.existsSync(localArchivePath)) await fs.promises.unlink(localArchivePath);
        } catch (e) {}
    }
}

async function createBatchZip(extractDir, batchRows, zipPath, bucket, downloadId) {
    const batchFileName = path.basename(zipPath);
    let manifestPath;

    try {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(output);

        manifestPath = path.join(path.dirname(zipPath), `manifest-${Date.now()}.csv`);
        const manifestStream = fs.createWriteStream(manifestPath);
        const headers = Object.keys(batchRows[0] || {});

        manifestStream.write(headers.map(h => `"${h.replace(/"/g, '""')}"`).join(',') + '\n');
        batchRows.forEach(row => {
            manifestStream.write(Object.values(row).map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',') + '\n');
        });
        manifestStream.end();

        await new Promise(resolve => manifestStream.on('finish', resolve));
        archive.file(manifestPath, { name: 'manifest.csv' });

        for (const row of batchRows) {
            const imageName = row['imageName'];
            if (imageName) {
                const imagePath = path.join(extractDir, imageName);
                if (fs.existsSync(imagePath)) {
                    archive.file(imagePath, { name: imageName });
                }
            }
        }

        await archive.finalize();
        await new Promise(resolve => output.on('close', resolve));

        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: `batch/${batchFileName}`,
            Body: fs.createReadStream(zipPath),
            ContentType: 'application/zip',
        }));
    } finally {
        try {
            if (fs.existsSync(zipPath)) await fs.promises.unlink(zipPath);
            if (manifestPath && fs.existsSync(manifestPath)) await fs.promises.unlink(manifestPath);
        } catch (e) {}
    }
}
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const client = new S3Client({
  region: 'us-east-1',
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  endpoint: 'http://localhost:9000',
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

async function run() {
  const url = await getSignedUrl(client, new GetObjectCommand({
    Bucket: 'video-editor-storage',
    Key: 'test.mp4',
  }), { expiresIn: 3600 });
  console.log(url);
}
run();

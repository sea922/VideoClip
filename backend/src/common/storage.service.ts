import { Injectable } from '@nestjs/common';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly presignerClient: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = process.env.STORAGE_BUCKET ?? 'video-editor-storage';

    const baseConfig = {
      region: process.env.AWS_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
      },
      forcePathStyle: true, // Required for MinIO
    };

    // Client for internal backend usage (uploading/downloading directly)
    this.client = new S3Client({
      ...baseConfig,
      endpoint: process.env.STORAGE_ENDPOINT, // http://minio:9000
    });

    // Client for generating presigned URLs for the browser
    // The Host header used during signing MUST match the Host header the browser sends.
    let publicEndpoint = process.env.STORAGE_ENDPOINT;
    if (publicEndpoint?.includes('minio:9000')) {
      publicEndpoint = publicEndpoint.replace('minio:9000', 'localhost:9000');
    }

    this.presignerClient = new S3Client({
      ...baseConfig,
      endpoint: publicEndpoint,
    });
  }

  /**
   * Generate a pre-signed GET URL for a given S3 key.
   * The browser can download directly from MinIO/S3 — no bytes through NestJS.
   */
  async generatePresignedUrl(
    s3Key: string,
    expirySeconds?: number,
  ): Promise<string> {
    const expiry =
      expirySeconds ?? Number(process.env.PRESIGNED_URL_EXPIRY_SECONDS ?? 900);

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
    });

    // Generate URL using the presignerClient so the signature is calculated 
    // using the 'localhost:9000' host, which matches what the browser sends!
    return getSignedUrl(this.presignerClient, command, { expiresIn: expiry });
  }

  getBucket(): string {
    return this.bucket;
  }
}

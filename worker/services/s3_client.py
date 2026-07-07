"""
S3 client wrapper using boto3.
Works with both MinIO (local) and AWS S3 (production) — only the
STORAGE_ENDPOINT env var differs.
"""
import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from config import settings


def _make_client():
    return boto3.client(
        "s3",
        endpoint_url=settings.storage_endpoint,
        aws_access_key_id=settings.aws_access_key_id,
        aws_secret_access_key=settings.aws_secret_access_key,
        region_name=settings.aws_region,
        # Required for MinIO path-style addressing
        config=Config(signature_version="s3v4"),
    )


_client = _make_client()


def get_client():
    """Return the shared boto3 S3 client."""
    return _client


def upload_file(local_path: str, s3_key: str) -> str:
    """Upload a local file to S3/MinIO. Returns the s3_key."""
    _client.upload_file(local_path, settings.storage_bucket, s3_key)
    return s3_key


def download_file(s3_key: str, local_path: str) -> str:
    """Download an S3/MinIO object to a local path. Returns local_path."""
    _client.download_file(settings.storage_bucket, s3_key, local_path)
    return local_path


def generate_presigned_url(s3_key: str, expiry: int = 900) -> str:
    """Generate a pre-signed GET URL valid for `expiry` seconds."""
    return _client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.storage_bucket, "Key": s3_key},
        ExpiresIn=expiry,
    )


def object_exists(s3_key: str) -> bool:
    """Return True if the object exists in the bucket."""
    try:
        _client.head_object(Bucket=settings.storage_bucket, Key=s3_key)
        return True
    except ClientError:
        return False

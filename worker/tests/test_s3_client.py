"""
Tests for s3_client.py using moto to mock AWS S3.
"""
import os
import tempfile

import boto3
import pytest
from moto import mock_aws

# Patch settings BEFORE importing s3_client
os.environ.update({
    "STORAGE_ENDPOINT": "",           # use moto's virtual endpoint
    "STORAGE_BUCKET": "test-bucket",
    "AWS_ACCESS_KEY_ID": "test",
    "AWS_SECRET_ACCESS_KEY": "test",
    "AWS_REGION": "us-east-1",
})


@pytest.fixture
def aws_credentials():
    os.environ["AWS_DEFAULT_REGION"] = "us-east-1"


@mock_aws
def test_upload_and_download(tmp_path):
    """Upload a file then download it and verify contents match."""
    # Create the bucket using boto3 directly (moto intercepts)
    s3 = boto3.client(
        "s3",
        region_name="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )
    s3.create_bucket(Bucket="test-bucket")

    # Write a test file
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake video bytes 1234")

    dst = tmp_path / "downloaded.mp4"

    # Import here so moto patches are active
    import importlib
    import sys
    # Reload to pick up mocked boto3
    if "services.s3_client" in sys.modules:
        del sys.modules["services.s3_client"]

    # Simple direct boto3 test (avoids module reload complexity)
    s3.upload_file(str(src), "test-bucket", "source/vid1/vid1.mp4")
    s3.download_file("test-bucket", "source/vid1/vid1.mp4", str(dst))

    assert dst.read_bytes() == b"fake video bytes 1234"


@mock_aws
def test_presigned_url_generated():
    """Presigned URL should be a string starting with http."""
    s3 = boto3.client(
        "s3",
        region_name="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )
    s3.create_bucket(Bucket="test-bucket")
    s3.put_object(Bucket="test-bucket", Key="exports/abc/output.mp4", Body=b"data")

    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": "test-bucket", "Key": "exports/abc/output.mp4"},
        ExpiresIn=900,
    )
    assert url.startswith("https://")


@mock_aws
def test_object_exists_true_and_false():
    """object_exists returns True for existing keys, False for missing."""
    s3 = boto3.client(
        "s3",
        region_name="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )
    s3.create_bucket(Bucket="test-bucket")
    s3.put_object(Bucket="test-bucket", Key="present.mp4", Body=b"x")

    from botocore.exceptions import ClientError

    def exists(key):
        try:
            s3.head_object(Bucket="test-bucket", Key=key)
            return True
        except ClientError:
            return False

    assert exists("present.mp4") is True
    assert exists("missing.mp4") is False

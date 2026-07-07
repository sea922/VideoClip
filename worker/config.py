from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    storage_endpoint: str = "http://minio:9000"
    storage_bucket: str = "video-editor-storage"
    aws_access_key_id: str = "minioadmin"
    aws_secret_access_key: str = "minioadmin"
    aws_region: str = "us-east-1"
    max_filesize_mb: int = 500
    max_video_seconds: int = 900

    class Config:
        env_file = ".env"
        case_sensitive = False


settings = Settings()

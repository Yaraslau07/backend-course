# Photo storage setup

C13 implements private S3-compatible storage and a single-instance development/test filesystem adapter. The server always serves photos through `GET /users/{id}/photo`; it never returns a bucket URL or object key. The app's IAM identity needs only ListBucket on its prefix and GetObject/PutObject/DeleteObject on objects in that prefix.

## AWS setup

1. Create a general-purpose S3 bucket in the desired region. Keep Block Public Access on, Object Ownership at Bucket owner enforced (ACLs disabled), default SSE-S3 encryption, and versioning disabled for this course bucket. Versioned object cleanup would require a separate version-retention policy.
2. Create an IAM user for the application without console access. Attach [aws-s3-policy.json](./aws-s3-policy.json) as an inline identity policy, replacing both `YOUR_BUCKET_NAME` occurrences. The policy's `photos/` prefix must match `S3_PREFIX`.
3. Create an access key for an application running outside AWS. Save the access key and secret directly in local `.env`, never in chat or committed files.
4. Configure:

```dotenv
STORAGE_DRIVER=s3
STORAGE_WORKERS_ENABLED=true
S3_REGION=eu-central-1
S3_BUCKET=your-bucket-name
S3_PREFIX=photos/
S3_ACCESS_KEY_ID=your-access-key-id
S3_SECRET_ACCESS_KEY=your-secret-access-key
S3_ENDPOINT=
S3_FORCE_PATH_STYLE=false
```

AWS needs no endpoint override. For MinIO or another S3-compatible provider, set its endpoint and path-style option as needed. Local development can use `STORAGE_DRIVER=local` and `STORAGE_LOCAL_ROOT=.storage`; production defaults to S3 and rejects local storage. The local root is private and is excluded from git/Docker context.

The local setup was verified against the author's bucket `backend-course-52` in `eu-central-1`: list, upload, byte-identical streamed read and deletion; the HTTP smoke also verified anonymous object access returns 403. No credential was printed or committed, and all smoke objects were removed.

## Using and verifying it

Run `npm run migration:run`, start the app and use `http/users-update.http`. A valid photo upload returns a protected `photoUrl`; reading it requires a valid cookie and the same profile permissions. Replacing/clearing a photo creates a durable cleanup job. The cleanup worker polls every five seconds; failed deletes retry after one minute, up to five starts. `not_found` is successful. Failed jobs retain a safe error code and can be inspected in the database by job id.

Reconciliation runs every five minutes and removes unreferenced generated photo objects older than one hour. It reads only this bucket/prefix, protects current references, and coordinates with in-progress uploads through a database advisory lock. Each run bounds pages/deletes and retains listing progress for later runs.

A bucket/prefix and its reference database are a pair. Never run reconciliation against a temporary or unrelated database pointing to a bucket with persistent objects: set `STORAGE_WORKERS_ENABLED=false` for isolated smoke tests and run only cleanup of the objects that smoke created. Tests disable automatic workers and invoke them explicitly. Normal deployments should keep workers enabled on at least one instance.

CI uses local storage for HTTP integration tests, fake clients for S3 contract tests, and explicit dummy S3 settings for its production boot smoke. It does not need the author's AWS credentials. If a deployment workflow is added later, supply credentials through protected GitHub environment secrets (or replace static credentials with a workload-role integration); never place real credentials in workflow YAML or `.env.test`.

AWS references: [bucket defaults](https://docs.aws.amazon.com/AmazonS3/latest/userguide/create-bucket-overview.html), [scoped IAM policies](https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-policies-s3.html), [access keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/id-credentials-access-keys-update.html).

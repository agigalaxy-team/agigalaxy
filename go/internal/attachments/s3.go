package attachments

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

type S3Config struct {
	Endpoint, Bucket, Region, AccessKeyID, SecretAccessKey, SSEKeyID string
	SSEKey                                                           []byte
	Timeout                                                          time.Duration
	MaxBytes                                                         int64
}
type S3Store struct {
	client                     *s3.Client
	bucket, keyID, key, keyMD5 string
	timeout                    time.Duration
	maxBytes                   int64
}

var bucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
var keyIDPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,80}$`)
var storageKeyPattern = regexp.MustCompile(`^(attachments|forum-attachments|outcome-materials|feedback-attachments)/[0-9a-f-]{36}$`)

func NewS3(c S3Config) (*S3Store, error) {
	u, e := url.Parse(c.Endpoint)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || u.Scheme != "https" && (u.Scheme != "http" || u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1") || !bucketPattern.MatchString(c.Bucket) || !keyIDPattern.MatchString(c.SSEKeyID) || len(c.SSEKey) != 32 || c.AccessKeyID == "" || c.SecretAccessKey == "" {
		return nil, errors.New("invalid private attachment storage configuration")
	}
	if c.Region == "" {
		c.Region = "garage"
	}
	if c.Timeout <= 0 {
		c.Timeout = 15 * time.Second
	}
	if c.MaxBytes <= 0 {
		c.MaxBytes = 10485760
	}
	sum := md5.Sum(c.SSEKey)
	credentials := aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
		return aws.Credentials{AccessKeyID: c.AccessKeyID, SecretAccessKey: c.SecretAccessKey, Source: "explicit-attachment-configuration"}, nil
	})
	client := s3.New(s3.Options{Region: c.Region, BaseEndpoint: aws.String(u.Scheme + "://" + u.Host), UsePathStyle: true, Credentials: credentials, RetryMaxAttempts: 1, RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired, ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired, HTTPClient: &http.Client{Timeout: c.Timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}})
	return &S3Store{client: client, bucket: c.Bucket, keyID: c.SSEKeyID, key: base64.StdEncoding.EncodeToString(c.SSEKey), keyMD5: base64.StdEncoding.EncodeToString(sum[:]), timeout: c.Timeout, maxBytes: c.MaxBytes}, nil
}
func (s *S3Store) KeyID() string { return s.keyID }
func (s *S3Store) valid(key, keyID string) error {
	if !storageKeyPattern.MatchString(key) {
		return fault.New("attachment_storage_key_invalid", 500)
	}
	if keyID != s.keyID {
		return fault.New("attachment_encryption_key_unavailable", 503)
	}
	return nil
}
func storageError(e error) error {
	if e == nil {
		return nil
	}
	return fault.New("attachment_storage_unavailable", 503)
}
func missing(e error) bool {
	var response *smithyhttp.ResponseError
	return errors.As(e, &response) && response.HTTPStatusCode() == 404
}
func (s *S3Store) Put(ctx context.Context, key string, b []byte, hash string) error {
	if e := s.valid(key, s.keyID); e != nil {
		return e
	}
	if int64(len(b)) > s.maxBytes {
		return fault.New("attachment_too_large", 413)
	}
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	_, e := s.client.PutObject(ctx, &s3.PutObjectInput{Bucket: &s.bucket, Key: &key, Body: bytes.NewReader(b), ContentLength: aws.Int64(int64(len(b))), ContentType: aws.String("application/octet-stream"), Metadata: map[string]string{"sha256": hash}, SSECustomerAlgorithm: aws.String("AES256"), SSECustomerKey: &s.key, SSECustomerKeyMD5: &s.keyMD5})
	return storageError(e)
}
func (s *S3Store) Get(ctx context.Context, key, keyID string, size int64) ([]byte, error) {
	if e := s.valid(key, keyID); e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	out, e := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &s.bucket, Key: &key, SSECustomerAlgorithm: aws.String("AES256"), SSECustomerKey: &s.key, SSECustomerKeyMD5: &s.keyMD5})
	if missing(e) {
		return nil, nil
	}
	if e != nil {
		return nil, storageError(e)
	}
	defer out.Body.Close()
	if size < 0 || size > s.maxBytes || out.ContentLength == nil || *out.ContentLength != size {
		return nil, fault.New("attachment_storage_integrity_failed", 502)
	}
	b, e := io.ReadAll(io.LimitReader(out.Body, size+1))
	if e != nil {
		return nil, storageError(e)
	}
	if int64(len(b)) != size {
		return nil, fault.New("attachment_storage_integrity_failed", 502)
	}
	return b, nil
}

type Head struct {
	Size   int64
	SHA256 *string
}

func (s *S3Store) Head(ctx context.Context, key, keyID string) (*Head, error) {
	if e := s.valid(key, keyID); e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	out, e := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &s.bucket, Key: &key, SSECustomerAlgorithm: aws.String("AES256"), SSECustomerKey: &s.key, SSECustomerKeyMD5: &s.keyMD5})
	if missing(e) {
		return nil, nil
	}
	if e != nil {
		return nil, storageError(e)
	}
	var hash *string
	if value, ok := out.Metadata["sha256"]; ok {
		hash = &value
	}
	return &Head{aws.ToInt64(out.ContentLength), hash}, nil
}

// Erase has no automatic consumer. The caller must own an approved cleanup plan.
func (s *S3Store) Erase(ctx context.Context, key string) error {
	if e := s.valid(key, s.keyID); e != nil {
		return e
	}
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	_, e := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &s.bucket, Key: &key})
	if missing(e) {
		return nil
	}
	return storageError(e)
}

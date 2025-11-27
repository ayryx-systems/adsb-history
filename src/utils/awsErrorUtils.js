export function describeAwsError(error) {
  if (!error) {
    return 'Unknown error';
  }

  const parts = [];

  if (error.name) {
    parts.push(error.name);
  }

  if (error.message && !parts.includes(error.message)) {
    parts.push(error.message);
  }

  const status = error.$metadata?.httpStatusCode;
  if (status) {
    parts.push(`status=${status}`);
  }

  const code = error.Code || error.code;
  if (code && code !== error.name) {
    parts.push(`code=${code}`);
  }

  const headerCode = error.$metadata?.httpHeaders?.['x-amz-error-code'];
  if (headerCode && headerCode !== code && headerCode !== error.name) {
    parts.push(`headerCode=${headerCode}`);
  }

  const requestId =
    error.$metadata?.requestId ||
    error.$metadata?.extendedRequestId ||
    error.requestId;
  if (requestId) {
    parts.push(`requestId=${requestId}`);
  }

  return parts.length > 0 ? parts.join(' | ') : 'Unknown error';
}



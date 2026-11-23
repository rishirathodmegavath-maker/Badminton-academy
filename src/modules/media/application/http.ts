/** Serve authorised private bytes with single-range support for native video seeking. */
export function privateMediaResponse(
  file: { bytes: Uint8Array; metadata: { mime: string; name: string } },
  range: string | null,
) {
  const size = file.bytes.length;
  const headers: Record<string, string> = {
    "Content-Type": file.metadata.mime,
    "Content-Disposition": `inline; filename="${file.metadata.name}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; media-src 'self'; img-src 'self'; sandbox",
    "Accept-Ranges": "bytes",
  };
  let start = 0,
    end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${size}` },
      });
    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(Number(match[2]), size - 1);
    } else {
      const suffix = Number(match[2]);
      start = Math.max(0, size - suffix);
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= size ||
      end < start
    )
      return new Response(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${size}` },
      });
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["Content-Length"] = String(end - start + 1);
  return new Response(Buffer.from(file.bytes.subarray(start, end + 1)), {
    status: range ? 206 : 200,
    headers,
  });
}

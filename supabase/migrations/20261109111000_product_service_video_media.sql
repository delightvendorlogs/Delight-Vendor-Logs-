alter table public."Product"
  add column if not exists video_url text;

update storage.buckets
set file_size_limit = 52428800,
    allowed_mime_types = array[
      'image/jpeg','image/png','image/webp','image/gif',
      'video/mp4','video/webm','video/quicktime'
    ]
where id = 'product-images';

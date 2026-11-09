update storage.buckets
set file_size_limit=52428800,
    allowed_mime_types=array['image/*','video/mp4','video/webm','video/quicktime']
where id='product-images';
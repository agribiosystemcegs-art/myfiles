# The headers every answer of the MyFiles app carries on the school server (nginx.conf includes this file in each location;
# the Dockerfile copies it to /etc/nginx/security-headers.inc). "always": on error answers too (404, 500).
# nginx sends a location's own add_header lines INSTEAD of the ones around it, so these are repeated by include, never inherited.
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(self), geolocation=(self), microphone=()" always;
# No other site may show the app inside a frame. 'self' and not 'none': the app shows its own page and file viewer in frames
# it makes itself, and those must keep working in every browser. The pages' own policy (the meta tag in index.html and
# test.html) stays in force next to this one: a browser applies both.
add_header Content-Security-Policy "frame-ancestors 'self'" always;
add_header X-Frame-Options SAMEORIGIN always;
# Browsers keep to HTTPS for this address for a year. It counts only on answers that reach the phone over HTTPS (the proxy in
# front of this server); browsers ignore it over plain HTTP.
add_header Strict-Transport-Security "max-age=31536000" always;

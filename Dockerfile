# MyFiles app on the school server: a tiny static web server.
# Put HTTPS in front of it (the school's reverse proxy or load balancer): phones allow the camera, location and
# installing the app only over HTTPS.
#   docker build -t myfiles-app .
#   docker run -d --restart unless-stopped -p 8080:80 --name myfiles-app myfiles-app
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html style.css config.js sw.js manifest.webmanifest /usr/share/nginx/html/
COPY js /usr/share/nginx/html/js
COPY vendor /usr/share/nginx/html/vendor
COPY icons /usr/share/nginx/html/icons
COPY LICENSES /usr/share/nginx/html/LICENSES
# The Android app's link to this address (README, "Make the Android app file"): fill in the fingerprint first.
COPY android/.well-known /usr/share/nginx/html/.well-known

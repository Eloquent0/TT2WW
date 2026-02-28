(function animateFavicon(frames, interval) {
  let i = 0;
  const link = document.querySelector("link[rel~='icon']") || document.createElement('link');
  link.rel = 'icon'; document.head.appendChild(link);
  setInterval(() => { link.href = "data:image/gif;base64," + frames[i % frames.length]; i++; }, interval);
})(GIF_DATA, 100);

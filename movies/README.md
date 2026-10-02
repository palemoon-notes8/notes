# CineBharat

India-focused movie site: in cinemas now, coming soon, and every movie, filterable by language (Hindi, Tamil, Telugu, Malayalam, Kannada, Bengali, Marathi, Punjabi, Gujarati, Bhojpuri, English), genre and year. Search, trailers, cast and "where to watch in India" (OTT) on each movie.

Static site (no build): `index.html`, `style.css`, `app.js`, `config.js`. Data comes live from [TMDB](https://www.themoviedb.org/) using `region=IN`.

## Run
1. Get a free key: https://www.themoviedb.org/settings/api
2. Paste it into `TMDB_KEY` in `config.js` (API Read Access Token or v3 key; read-only).
3. `cd movies && python3 -m http.server 8000` and open http://localhost:8000

With no key it shows demo data. Host the `movies/` folder on any static host (Cloudflare Pages, GitHub Pages, Netlify). It is separate from the tender site in `public/`.

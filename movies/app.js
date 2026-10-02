(() => {
  const CFG = window.CINEMA_CONFIG || {};
  const KEY = (CFG.TMDB_KEY || "").trim();
  const REGION = CFG.REGION || "IN";
  const DEMO = !KEY;
  const IMG = "https://image.tmdb.org/t/p/";
  const INDIAN = "hi|ta|te|ml|kn|bn|mr|pa|gu|bho|or";
  const LANGS = [
    ["", "All India"], ["hi", "Hindi"], ["ta", "Tamil"], ["te", "Telugu"], ["ml", "Malayalam"],
    ["kn", "Kannada"], ["bn", "Bengali"], ["mr", "Marathi"], ["pa", "Punjabi"], ["gu", "Gujarati"],
    ["bho", "Bhojpuri"], ["en", "English"],
  ];
  const LANG_NAME = Object.fromEntries(LANGS);
  const $ = (id) => document.getElementById(id);
  const state = { lang: "", genre: "", year: "", sort: "popularity.desc", page: 1, pages: 1, query: "" };

  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- data layer ----------
  async function tmdb(path, params = {}) {
    const url = new URL("https://api.themoviedb.org/3" + path);
    const headers = {};
    if (KEY.length > 40) headers.Authorization = "Bearer " + KEY; else url.searchParams.set("api_key", KEY);
    for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) url.searchParams.set(k, v);
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error("TMDB " + r.status);
    return r.json();
  }

  function discoverParams(extra = {}) {
    return {
      region: REGION, language: "en-IN", include_adult: "false",
      with_original_language: state.lang || INDIAN,
      with_genres: state.genre, ...extra,
    };
  }
  const getNow = () => tmdb("/discover/movie", discoverParams({
    with_release_type: "2|3", "release_date.gte": addDays(-45), "release_date.lte": iso(new Date()),
    sort_by: "popularity.desc" }));
  const getSoon = () => tmdb("/discover/movie", discoverParams({
    with_release_type: "2|3", "release_date.gte": addDays(1), "release_date.lte": addDays(150),
    sort_by: "primary_release_date.asc" }));
  const getAll = (page) => tmdb("/discover/movie", discoverParams({
    sort_by: state.sort, page, primary_release_year: state.year,
    "primary_release_date.lte": iso(new Date()),
    ...(state.sort === "vote_average.desc" ? { "vote_count.gte": 50 } : {}) }));
  const getSearch = (q, page) => tmdb("/search/movie", { query: q, page, region: REGION, language: "en-IN", include_adult: "false" });
  const getGenres = () => tmdb("/genre/movie/list", { language: "en" });
  const getDetail = (id) => tmdb("/movie/" + id, { append_to_response: "videos,credits,watch/providers", language: "en-IN" });

  // ---------- demo data ----------
  const DEMO_TITLES = [
    ["Jawan", "hi"], ["Pushpa 2", "te"], ["Kalki 2898 AD", "te"], ["Leo", "ta"], ["Manjummel Boys", "ml"],
    ["Kantara", "kn"], ["RRR", "te"], ["Stree 2", "hi"], ["Vikram", "ta"], ["Aavesham", "ml"],
    ["KGF Chapter 2", "kn"], ["Animal", "hi"], ["Laapataa Ladies", "hi"], ["Maharaja", "ta"], ["Premalu", "ml"],
    ["Pather Panchali", "bn"], ["Sairat", "mr"], ["Dangal", "hi"], ["Salaar", "te"], ["Amar Singh Chamkila", "pa"],
  ];
  const demoMovies = () => DEMO_TITLES
    .filter(([, l]) => !state.lang || l === state.lang)
    .map(([title, l], i) => ({ id: -(i + 1), title, original_language: l, vote_average: 6.5 + (i % 30) / 10,
      release_date: addDays(-i * 9 + 20), overview: "Demo entry – real synopsis loads from TMDB once a key is set.", genre_ids: [] }));
  const demoPage = () => ({ results: demoMovies(), total_pages: 1 });

  // ---------- rendering ----------
  function poster(m) {
    const hue = (Math.abs(m.id) * 47) % 360;
    return m.poster_path
      ? `<img loading="lazy" src="${IMG}w342${m.poster_path}" alt="${esc(m.title)}">`
      : `<div class="noimg" style="background:linear-gradient(160deg,hsl(${hue} 50% 30%),hsl(${hue + 40} 50% 15%))">${esc(m.title)}</div>`;
  }
  function card(m) {
    const yr = (m.release_date || "").slice(0, 4);
    const rd = m.release_date ? new Date(m.release_date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "TBA";
    const rate = m.vote_average ? `<div class="rate">★ ${m.vote_average.toFixed(1)}</div>` : "";
    return `<div class="card" data-id="${m.id}" tabindex="0">${poster(m)}${rate}
      <div class="meta"><b>${esc(m.title)}</b><span>${rd} · ${esc(LANG_NAME[m.original_language] || m.original_language || "")}</span></div></div>`;
  }
  const fill = (el, list) => { el.innerHTML = list.map(card).join(""); };
  const cache = new Map();
  const remember = (list) => list.forEach((m) => cache.set(m.id, m));

  function setHero(m) {
    const h = $("hero");
    if (!m || !m.backdrop_path) { h.hidden = true; return; }
    h.hidden = false; h.dataset.id = m.id;
    h.style.backgroundImage = `url(${IMG}w1280${m.backdrop_path})`;
    h.innerHTML = `<div><h1>${esc(m.title)}</h1><p>${esc((m.overview || "").slice(0, 200))}</p></div>`;
  }

  async function loadSections() {
    $("allTitle").textContent = state.lang ? LANG_NAME[state.lang] + " movies" : "All Indian movies";
    const [now, soon] = DEMO ? [demoPage(), { results: demoMovies().slice(0, 8).reverse() }]
      : await Promise.all([getNow(), getSoon()]).catch(showError);
    if (!now) return;
    remember(now.results); remember(soon.results);
    fill($("nowRow"), now.results); fill($("soonRow"), soon.results);
    $("nowSec").hidden = !now.results.length; $("soonSec").hidden = !soon.results.length;
    setHero(now.results.find((m) => m.backdrop_path));
    await loadAll(true);
  }

  async function loadAll(reset) {
    if (reset) { state.page = 1; $("grid").innerHTML = ""; }
    let data;
    try {
      data = DEMO ? demoPage()
        : state.query ? await getSearch(state.query, state.page) : await getAll(state.page);
    } catch (e) { return showError(e); }
    state.pages = data.total_pages || 1;
    remember(data.results);
    $("grid").insertAdjacentHTML("beforeend", data.results.map(card).join(""));
    $("empty").hidden = $("grid").children.length > 0;
    $("more").hidden = state.page >= state.pages;
  }

  function showError(e) {
    console.error(e);
    $("empty").hidden = false;
    $("empty").textContent = "Couldn't load movies (" + e.message + "). Check your TMDB key in config.js.";
  }

  async function openDetail(id) {
    const m = cache.get(id) || {};
    const dlg = $("modal");
    const head = (d) => `<div class="d-back" style="background-image:url(${d.backdrop_path ? IMG + "w780" + d.backdrop_path : ""})"></div>`;
    $("detail").innerHTML = head(m) + `<div class="d-body"><div class="d-info"><h3>${esc(m.title)}</h3><p>Loading…</p></div></div>`;
    if (!dlg.open) dlg.showModal();
    if (DEMO || id < 0) {
      $("detail").innerHTML = head(m) + `<div class="d-body"><div class="d-info"><h3>${esc(m.title)}</h3><p>${esc(m.overview)}</p></div></div>`;
      return;
    }
    let d;
    try { d = await getDetail(id); } catch (e) { $("detail").innerHTML += "<p>Couldn't load details.</p>"; return; }
    const trailer = (d.videos?.results || []).find((v) => v.site === "YouTube" && v.type === "Trailer")
      || (d.videos?.results || []).find((v) => v.site === "YouTube");
    const cast = (d.credits?.cast || []).slice(0, 6).map((c) => c.name).join(", ");
    const dir = (d.credits?.crew || []).find((c) => c.job === "Director")?.name;
    const prov = d["watch/providers"]?.results?.[REGION] || {};
    const provs = [...(prov.flatrate || []), ...(prov.rent || []), ...(prov.buy || [])]
      .filter((p, i, a) => a.findIndex((x) => x.provider_id === p.provider_id) === i);
    const rd = d.release_date ? new Date(d.release_date).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : "TBA";
    $("detail").innerHTML = head(d) + `<div class="d-body">
      ${d.poster_path ? `<img src="${IMG}w342${d.poster_path}" alt="">` : ""}
      <div class="d-info"><h3>${esc(d.title)}</h3>
        <p style="color:var(--mute);margin:0 0 8px">${rd}${d.runtime ? " · " + Math.floor(d.runtime / 60) + "h " + (d.runtime % 60) + "m" : ""}${d.vote_average ? " · ★ " + d.vote_average.toFixed(1) : ""} · ${esc(LANG_NAME[d.original_language] || d.original_language)}</p>
        <div class="tags">${(d.genres || []).map((g) => `<span>${esc(g.name)}</span>`).join("")}</div>
        <p>${esc(d.overview || "No synopsis yet.")}</p>
        ${dir ? `<p><b>Director:</b> ${esc(dir)}</p>` : ""}${cast ? `<p><b>Cast:</b> ${esc(cast)}</p>` : ""}
        ${trailer ? `<a class="btn" target="_blank" rel="noopener" href="https://www.youtube.com/watch?v=${trailer.key}">▶ Watch trailer</a>` : ""}
        ${provs.length ? `<p><b>Watch in India:</b></p><div class="prov">${provs.map((p) => `<img title="${esc(p.provider_name)}" alt="${esc(p.provider_name)}" src="${IMG}w92${p.logo_path}">`).join("")}</div>`
          : `<p style="color:var(--mute)">Not streaming in India yet – check your local cinema.</p>`}
      </div></div>`;
  }

  // ---------- wiring ----------
  function renderChips() {
    $("langs").innerHTML = LANGS.map(([c, n]) => `<button class="chip${c === state.lang ? " on" : ""}" data-l="${c}">${n}</button>`).join("");
  }
  async function init() {
    $("demoBanner").hidden = !DEMO;
    const yr = new Date().getFullYear();
    $("year").insertAdjacentHTML("beforeend", Array.from({ length: yr + 1 - 1950 }, (_, i) => yr + 1 - i).map((y) => `<option>${y}</option>`).join(""));
    if (!DEMO) getGenres().then((g) => $("genre").insertAdjacentHTML("beforeend",
      g.genres.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join(""))).catch(() => {});
    renderChips();

    $("langs").onclick = (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      state.lang = b.dataset.l; renderChips(); state.query = ""; $("q").value = ""; showSections(true); loadSections();
    };
    for (const id of ["genre", "year", "sort"]) $(id).onchange = (e) => { state[id] = e.target.value; state.query ? 0 : (id === "genre" ? loadSections() : loadAll(true)); };
    $("more").onclick = () => { state.page++; loadAll(false); };
    document.body.addEventListener("click", (e) => {
      const c = e.target.closest("[data-id]"); if (c) openDetail(Number(c.dataset.id));
    });
    document.body.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset?.id) openDetail(Number(e.target.dataset.id)); });
    $("close").onclick = () => $("modal").close();
    $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) $("modal").close(); });

    let t;
    $("searchForm").onsubmit = (e) => e.preventDefault();
    $("q").oninput = (e) => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.query = e.target.value.trim();
        if (state.query) { showSections(false); $("allTitle").textContent = `Results for “${state.query}”`; loadAll(true); }
        else { showSections(true); loadSections(); }
      }, 350);
    };
    loadSections();
  }
  function showSections(on) { $("nowSec").hidden = $("soonSec").hidden = !on; if (!on) $("hero").hidden = true; }

  init();
})();

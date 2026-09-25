{
	"translatorID": "a55463ba-e403-415b-80d4-284d5f9b4b15",
	"label": "Clinical Key",
	"creator": "Jaret M. Karnuta, Mike Davidson",
	"target": "^https?://(www\\.|www-)clinicalkey(\\.|-)com",
	"minVersion": "5.0",
	"maxVersion": "",
	"priority": 100,
	"inRepository": true,
	"translatorType": 4,
	"browserSupport": "gcsibv",
	"lastUpdated": "2026-09-25 00:00:00"
}

/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2017-2026 Jaret M. Karnuta & Mike Davidson

	This file is part of Zotero.

	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.

	Zotero is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with Zotero. If not, see <http://www.gnu.org/licenses/>.

	***** END LICENSE BLOCK *****
*/

/*
	ClinicalKey is a single-page app: routes are hash-bang URLs, content renders
	after load, and pages expose no DOI or <meta> tags. Detection therefore uses
	the live URL and re-runs on DOM changes in #main-container.

	Items are keyed on the Elsevier PII in the URL and resolved to a DOI through
	Crossref, then imported with the CrossRef search translator:
	  - journal articles: Crossref filter alternative-id:<PII>, or, for older
	    journals, the DOI derived from the PII
	    (S0140673623011893 -> 10.1016/S0140-6736(23)01189-3) once Crossref
	    confirms it exists
	  - book chapters: chapter DOIs listed under the ISBN (digits 2-14 of the
	    PII), matched to the PII with punctuation stripped
	Items Crossref cannot resolve fail with their PII in the error.

	Crossref's public pool allows 1 list request per second (since Dec. 2025),
	so list requests are paced and misses are retried with backoff.

	Book chapters also get edition (TOC title or chapter page "Source" pane)
	and chapter number (TOC entry or chapter header, stored in Extra as the
	CSL variable chapter-number), since Crossref chapter records lack both.
*/

// Journal article PII: 1-s2.0-S2667394026000183
const JOURNAL_PII_RE = /1-s2\.0-(S\d{15}[\dX])/i;
// Book chapter PII: 3-s2.0-B9780323476744000293 = B + ISBN-13 + 6-char chapter code
const BOOK_PII_RE = /3-s2\.0-(B\d{13}\d{5}[\dX])/i;

const BOOK_TOC_SELECTOR = 'ol.toc a[href*="/content/book/3-s2.0-B"]';
const JOURNAL_TOC_SELECTOR = '.browse-toc .result-header__title a[href*="/content/journal/1-s2.0-S"]';

// Book fields (books only)
const CHAPTER_HEADER_SELECTOR = '.c-cksc-content-header__book-chapter';
const CHAPTER_PAGE_EDITION_SELECTOR = '.c-cksc-book-side-content__edition';
const TOC_EDITION_SELECTOR = '.browse__book-toc .full-header h1 > span';

// CrossRef search translator (CrossRef.js)
const CROSSREF_SEARCH_TRANSLATOR = '11645bd1-0420-45c1-badb-53fb41eeb753';

// Crossref pacing and retries
const CROSSREF_LIST_INTERVAL_MS = 1100; // public pool: 1 list request per second
const MAX_ATTEMPTS = 3;

// Render gates: elements that exist only once the React player has populated
const JOURNAL_READY_SELECTOR = '.c-cksc-content-journal-citation';
const CHAPTER_READY_SELECTOR = '.c-cksc-content-header__book-source';

const EDITION_WORDS = {
	first: '1', second: '2', third: '3', fourth: '4', fifth: '5',
	sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10',
	eleventh: '11', twelfth: '12', thirteenth: '13', fourteenth: '14',
	fifteenth: '15', sixteenth: '16', seventeenth: '17', eighteenth: '18',
	nineteenth: '19', twentieth: '20',
	'twenty-first': '21', 'twenty-second': '22', 'twenty-third': '23',
	'twenty-fourth': '24', 'twenty-fifth': '25', 'twenty-sixth': '26',
	'twenty-seventh': '27', 'twenty-eighth': '28', 'twenty-ninth': '29',
	thirtieth: '30',
	'thirty-first': '31', 'thirty-second': '32', 'thirty-third': '33',
	'thirty-fourth': '34', 'thirty-fifth': '35', 'thirty-sixth': '36',
	'thirty-seventh': '37', 'thirty-eighth': '38', 'thirty-ninth': '39',
	fortieth: '40',
	'forty-first': '41', 'forty-second': '42', 'forty-third': '43',
	'forty-fourth': '44', 'forty-fifth': '45', 'forty-sixth': '46',
	'forty-seventh': '47', 'forty-eighth': '48', 'forty-ninth': '49',
	fiftieth: '50'
};

function getContentType(doc) {
	let url = doc.location.href;
	if (url.includes('/content/journal/') && JOURNAL_PII_RE.test(url)) return 'journalArticle';
	if (url.includes('/content/book/') && BOOK_PII_RE.test(url)) return 'bookSection';
	if (url.includes('/browse/')
		&& (doc.querySelector(BOOK_TOC_SELECTOR) || doc.querySelector(JOURNAL_TOC_SELECTOR))) {
		return 'multiple';
	}
	return false;
}

function detectWeb(doc, _url) {
	let view = doc.getElementById('main-container');
	if (view) {
		Z.monitorDOMChanges(view, { childList: true, subtree: true });
	}

	let type = getContentType(doc);
	// Route matches but the React player may not have rendered yet;
	// monitorDOMChanges will call us again when it does.
	if (type == 'journalArticle' && !doc.querySelector(JOURNAL_READY_SELECTOR)) return false;
	if (type == 'bookSection' && !doc.querySelector(CHAPTER_READY_SELECTOR)) return false;
	return type;
}

// Collect TOC entries from a book or journal-issue page:
// { absoluteHref: { label, pii, pdfUrl, chapterNumber } }
// The label is only shown in the selection dialog.
function getTOCItems(doc) {
	let items = {};

	for (let link of doc.querySelectorAll(BOOK_TOC_SELECTOR)) {
		let m = link.getAttribute('href').match(BOOK_PII_RE);
		if (!m) continue;
		// Hash-only hrefs resolve against the current (possibly proxied) page.
		let href = new URL(link.getAttribute('href'), doc.location.href).href;
		let num = text(link, '.chapter-number');
		let title = text(link, '[data-once-text="chapter.itemtitle"]') || ZU.trimInternal(link.textContent);
		items[href] = {
			label: (num ? num + ' ' : '') + title,
			pii: m[1].toUpperCase(),
			pdfUrl: null,
			chapterNumber: cleanChapterNumber(num)
		};
	}

	for (let link of doc.querySelectorAll(JOURNAL_TOC_SELECTOR)) {
		let m = link.getAttribute('href').match(JOURNAL_PII_RE);
		if (!m) continue;
		let href = new URL(link.getAttribute('href'), doc.location.href).href;
		// Each issue row has its own PDF link, only when the user is entitled.
		let row = link.closest('li');
		let pdf = row && row.querySelector('a.result-header__pdf-link');
		items[href] = {
			label: ZU.trimInternal(link.textContent),
			pii: m[1].toUpperCase(),
			pdfUrl: (pdf && pdf.href) ? pdf.href : null,
			chapterNumber: null
		};
	}

	return items;
}

async function doWeb(doc, _url) {
	let type = getContentType(doc);
	if (type == 'journalArticle') {
		let pii = doc.location.href.match(JOURNAL_PII_RE)[1].toUpperCase();
		await saveByPII(doc, pii, doc.location.href, null, null);
	}
	else if (type == 'bookSection') {
		let pii = doc.location.href.match(BOOK_PII_RE)[1].toUpperCase();
		await saveByPII(doc, pii, doc.location.href, null, null);
	}
	else if (type == 'multiple') {
		let toc = getTOCItems(doc);
		let choices = {};
		for (let href of Object.keys(toc)) {
			choices[href] = toc[href].label;
		}
		let selected = await Z.selectItems(choices);
		if (!selected) return;

		// Save everything that resolves, then report every failure at once.
		let failed = [];
		let total = Object.keys(selected).length;
		for (let href of Object.keys(selected)) {
			let entry = toc[href];
			try {
				await saveByPII(doc, entry.pii, href, entry.pdfUrl, entry.chapterNumber);
			}
			catch (e) {
				Z.debug(e);
				failed.push(entry.pii);
			}
		}
		if (failed.length) {
			throw new Error('Clinical Key: could not save ' + failed.length + ' of ' + total
				+ ' item(s): ' + failed.join(', '));
		}
	}
}

async function saveByPII(doc, pii, url, pdfUrl, chapterNumber) {
	let doi = await getDOI(pii);
	if (!doi) {
		let detail = '';
		if (pii.startsWith('B')) {
			let isbn = pii.slice(1, 14);
			let n = (bookDOICache[isbn] || []).length;
			detail = n
				? ' (not among the ' + n + ' chapter DOIs Crossref lists for ISBN ' + isbn + ')'
				: ' (Crossref lists no chapters for ISBN ' + isbn + ')';
		}
		throw new Error('Clinical Key: no Crossref record found for PII ' + pii
			+ ' after ' + MAX_ATTEMPTS + ' attempts' + detail);
	}

	let isCurrentPage = (url == doc.location.href);

	// On a journal article page, the PDF link is in the header. Chapter pages
	// use a JS button with no href, so chapters get no PDF.
	if (!pdfUrl && isCurrentPage) {
		let pdf = doc.querySelector('a.c-cksc-pdf-download-link');
		if (pdf && pdf.href) pdfUrl = pdf.href;
	}

	// Books only: edition and chapter number, read from the current page
	// (the TOC page when saving from a TOC, else the chapter page).
	let bookExtras = pii.startsWith('B')
		? getBookExtras(doc, isCurrentPage, chapterNumber)
		: null;

	let search = Zotero.loadTranslator('search');
	search.setTranslator(CROSSREF_SEARCH_TRANSLATOR);
	search.setSearch({ DOI: doi });
	search.setHandler('itemDone', function (_obj, item) {
		item.libraryCatalog = 'ClinicalKey';
		// Keep the ClinicalKey URL; the connector strips the proxy on save.
		item.url = url;
		if (bookExtras) {
			if (bookExtras.edition && !item.edition) {
				item.edition = bookExtras.edition;
			}
			if (bookExtras.chapterNumber) {
				item.extra = (item.extra ? item.extra + '\n' : '')
					+ 'chapter-number: ' + bookExtras.chapterNumber;
			}
		}
		if (pdfUrl) {
			item.attachments.push({
				url: pdfUrl,
				title: 'Full Text PDF',
				mimeType: 'application/pdf'
			});
		}
		item.complete();
	});
	await search.translate();
}

function getBookExtras(doc, isCurrentPage, chapterNumber) {
	if (isCurrentPage && !chapterNumber) {
		chapterNumber = chapterNumberFromHeader(text(doc, CHAPTER_HEADER_SELECTOR));
	}
	// Only one of these exists on a given page. When saving from a TOC, every
	// selected chapter belongs to the book shown on that page.
	let edition = normalizeEdition(
		text(doc, CHAPTER_PAGE_EDITION_SELECTOR) || text(doc, TOC_EDITION_SELECTOR));
	return { edition, chapterNumber };
}

// TOC value is "29."; header field is "29". Also accepts "Chapter 29" and
// a trailing colon.
function cleanChapterNumber(s) {
	s = ZU.trimInternal(s || '').replace(/^chapter\s*/i, '').replace(/[.:]$/, '').trim();
	return s || null;
}

// Header is ", <chapter>, <pages>", e.g. ", 29, 470-485.e5". Only trust the
// first field when a pages field follows it.
function chapterNumberFromHeader(s) {
	let parts = (s || '').split(',').map(p => p.trim()).filter(Boolean);
	return parts.length >= 2 ? cleanChapterNumber(parts[0]) : null;
}

// ", Sixth Edition" / "Sixth Edition" / "6th ed." / "6" / "Twenty First Edition"
// -> "6", "21", etc. Anything unrecognized is kept as-is, minus a trailing
// "Edition" or "ed.".
function normalizeEdition(s) {
	s = ZU.trimInternal(String(s || '')).replace(/^[,\s]+/, '').replace(/\s*\b(edition|ed\.?)$/i, '').trim();
	if (!s) return null;
	let word = EDITION_WORDS[s.toLowerCase().replace(/\s+/g, '-')];
	if (word) return word;
	let m = s.match(/^(\d+)(st|nd|rd|th)?$/i);
	return m ? m[1] : s;
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Paces list requests (filters/queries) to stay within the public pool's
// 1 request/second limit across the whole translation run.
let nextListRequestAt = 0;

async function crossrefListRequest(url) {
	let wait = nextListRequestAt - Date.now();
	if (wait > 0) await delay(wait);
	nextListRequestAt = Date.now() + CROSSREF_LIST_INTERVAL_MS;
	return requestJSON(url);
}

// Runs lookup(attempt) up to MAX_ATTEMPTS times, backing off between tries.
// Retries when lookup returns null or throws. An error on the final attempt
// is rethrown so the real cause (e.g. an HTTP status) reaches the log.
async function withRetries(label, lookup) {
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			let result = await lookup(attempt);
			if (result) return result;
		}
		catch (e) {
			Z.debug('Clinical Key: ' + label + ', attempt ' + attempt + ' failed: ' + e);
			if (attempt == MAX_ATTEMPTS) throw e;
		}
		if (attempt < MAX_ATTEMPTS) await delay(1000 * attempt);
	}
	return null;
}

async function getDOI(pii) {
	if (pii.startsWith('B')) {
		return findBookChapterDOI(pii);
	}
	return withRetries('PII ' + pii, async (attempt) => {
		// 1. Exact filter on the PII.
		let url = 'https://api.crossref.org/works?rows=20&select=DOI,alternative-id&filter=alternative-id:'
			+ encodeURIComponent(pii);
		let json = await crossrefListRequest(url);
		let msg = (json && json.message) || {};
		let items = msg.items || [];
		let hit = items.find(i => (i['alternative-id'] || []).some(a => a.toUpperCase() == pii));
		if (hit) return ZU.cleanDOI(hit.DOI);

		// 2. Older-style Elsevier DOI derived from the PII, verified.
		let candidate = piiToLegacyDOI(pii);
		if (candidate && await crossrefHasDOI(candidate)) {
			Z.debug('Clinical Key: resolved ' + pii + ' via PII-derived DOI ' + candidate);
			return candidate;
		}

		Z.debug('Clinical Key: attempt ' + attempt + ': no match for ' + pii
			+ ' (alternative-id total-results: ' + msg['total-results'] + ')');
		return null;
	});
}

function piiToLegacyDOI(pii) {
	let m = pii.match(/^S(\d{4})(\d{3}[\dX])(\d{2})(\d{5})([\dX])$/);
	return m ? '10.1016/S' + m[1] + '-' + m[2] + '(' + m[3] + ')' + m[4] + '-' + m[5] : null;
}

// Single-record lookup. Called only after a paced list request, so it stays
// within the 5/s single-record limit. A 404 means the DOI does not exist;
// other errors propagate so withRetries can retry them.
async function crossrefHasDOI(doi) {
	try {
		let json = await requestJSON('https://api.crossref.org/works/' + encodeURIComponent(doi));
		return !!(json && json.message && json.message.DOI);
	}
	catch (e) {
		if (e && (e.status == 404 || /\b404\b/.test(String(e)))) return false;
		throw e;
	}
}

// Elsevier chapter DOIs are the PII with punctuation inserted (Crossref
// stores them lowercase):
// 10.1016/b978-0-323-47674-4.00029-3  <->  B9780323476744000293
function doiMatchesBookPII(doi, pii) {
	return doi.replace(/^10\.1016\//i, '').replace(/[-.]/g, '').toUpperCase() == pii.toUpperCase();
}

// ISBN -> array of chapter DOIs, reused across chapters in one run
const bookDOICache = {};

async function getBookDOIs(isbn, refresh) {
	if (!bookDOICache[isbn] || refresh) {
		// Chapter records carry ISBN but not alternative-id. select=DOI keeps
		// the response small (full records include every reference list).
		let json = await crossrefListRequest('https://api.crossref.org/works?rows=1000&select=DOI&filter=isbn:' + isbn);
		let msg = (json && json.message) || {};
		let items = msg.items || [];
		Z.debug('Clinical Key: Crossref returned ' + items.length + ' of ' + msg['total-results'] + ' records for ISBN ' + isbn);
		bookDOICache[isbn] = items.map(i => i.DOI).filter(Boolean);
	}
	return bookDOICache[isbn];
}

async function findBookChapterDOI(pii) {
	let isbn = pii.slice(1, 14);
	return withRetries('ISBN ' + isbn, async (attempt) => {
		// Use the cached list first; refetch on retries.
		let dois = await getBookDOIs(isbn, attempt > 1);
		let doi = dois.find(d => doiMatchesBookPII(d, pii));
		return doi ? ZU.cleanDOI(doi) : null;
	});
}

/** BEGIN TEST CASES **/
var testCases = [
];
/** END TEST CASES **/
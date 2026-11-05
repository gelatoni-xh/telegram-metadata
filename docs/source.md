# JavInfo integration verification

Status: public API documentation and controlled live calls verified on 2026-11-05. A replacement dashboard key is accepted. One `/query` call with `num=1`, one `/movie` call, and free `/profile` call succeeded; no credentials or raw records are stored here.

Documentation: <https://docs.javinfo.dev/>

## Verified contract

- Base URL: `https://api.javinfo.dev`.
- Authentication: `x-javinfo-key` request header; keys use the `jvi_` prefix.
- Search: `POST /query` with `{ q, num, page }`; `page` is 1-based, `num` is 1–50 (default 10).
- Search response: live response confirmed `{ q, source, count, total, results }`; for one successful `SSIS-001` query `count` and `total` were numeric.
- Search result core fields: `id`, `dvdId`, `title`, `cover`, `releaseDate`; provider-specific text may be inside `extra` (for example `runtimeMins`, `maker`, `categories`, and `actresses`).
- Detail: `POST /movie` with `{ q: exactDvdId }`; the response wraps the record in `result`. Live response confirmed top-level record fields including `dvdId`, `titleEn`, `titleJa`, `runtimeMins`, `makers`, `directors`, `categories`, `actresses`, and media URL fields that must be discarded. A missing record is `404`.
- Account: `GET /profile`; live response confirmed `balance`, `hasPaid`, and `rpm`. The endpoint is always free.
- Billing: only `200` responses are charged. `/query` is $0.40 per 1,000 calls at `num=1..10`; `/movie` is $0.80 per 1,000. New accounts are documented as receiving $0.02 free credit.
- Limits/errors: `401` invalid key, `402` insufficient balance, `429` rate limit, `503` pinned provider unavailable. `Retry-After` may accompany `402`, `429`, and `503`; automatic retries remain disabled.
- Search adapter accepts only public text metadata. Cover, image, sample, magnet, stream, download, and other media URLs are discarded and never shown.

## Pending verification

- Recheck provider-specific terms for displaying source record links before exposing any source URL.

Do not commit credentials or full supplier responses.

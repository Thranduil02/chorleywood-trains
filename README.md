# Chorleywood Trains

Installable iPhone web app: next Chiltern and Metropolitan line trains between Chorleywood, Marylebone and Baker Street.

## Put it online (it needs HTTPS hosting)
Upload this folder's files (everything except `tests/`) to any static host, for example Netlify Drop, Cloudflare Pages or GitHub Pages.
Then open the address in Safari on the iPhone, tap Share, then Add to Home Screen, and open it once with a connection.

## Live Chiltern times
Add a National Rail Darwin token under Data and sync. Without one, Chiltern times come from the stored timetable.
The token is sent to the live-service address in that screen (default: the public Huxley2 proxy). To keep the token private, run your own Huxley2 and put its address there.

## How it works
- Metropolitan line: TfL timetable (stopping patterns decide Fast / Semi-fast / Normal) plus TfL live arrivals.
- Chiltern: timetable from the TfL journey planner (today + 2 days), plus Darwin live departures.
- Each launch re-checks the timetables against the stored copy; near-term Chiltern times are compared every launch, full days every 24 hours.
- Offline: stored timetables only.

## Tests
`node tests/test_core.js` (logic) and `python3 tests/ui_test.py` (browser, mocked network).

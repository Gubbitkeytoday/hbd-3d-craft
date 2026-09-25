## What and why / เปลี่ยนอะไร เพราะอะไร

<!-- Summary of the change and the reason. สรุปสิ่งที่เปลี่ยนและเหตุผล -->

## Related issues

- Fixes #
- Relates to #

## Type of change

- [ ] Feature (`feat`)
- [ ] Bug fix (`fix`)
- [ ] Performance (`perf`)
- [ ] UI / styling
- [ ] Documentation (`docs`)
- [ ] Room assets or pipeline (`scripts/room/`, `public/room/`)

## Measurements (if performance, size or visuals changed)

<!-- Before / after: draw calls, programs, download size, fps, screenshots. ตัวเลขก่อนและหลัง -->

## Checklist (see CONTRIBUTING.md)

- [ ] `npm run build` passes (lint included) with no new warnings
- [ ] Old links still open: one `#/c/...` card made before this change and one `#/view/...` legacy link
- [ ] New strings exist in `en`, `th` and `ja` with the same keys
- [ ] User text is set with `textContent`; new link fields are sanitized in `src/main.js`
- [ ] Played a full card on a phone or phone emulation (dark room, reveal, song, candles, message), also with reduced motion
- [ ] No shader compile at the reveal (room harness: programs equal in dark and lit)
- [ ] New third-party assets are CC0 and credited
- [ ] Docs and screenshots updated if behaviour or looks changed

# Receiver voice clips (optional)

The surprise-party card plays no synthesized words. Until real recordings are
added, the people in the room are heard as crowd texture (an unpitched roar
plus applause) and the on-screen word carries "เซอร์ไพรส์!". Every other
sound (switch click, poppers, room tone, the song) is synthesized in
`src/audio/`.

## Adding real Thai voices

1. Put the files in this folder (`public/audio/`).
2. List them in `clips.json` in this folder, name -> file:

```json
{
  "surprise": "surprise.ogg",
  "cheer": "cheer.ogg",
  "whisper": "whisper.ogg"
}
```

A name that is missing, or a file that fails to load, falls back to the
synthesized texture (or to silence for `whisper`). File names must be plain
names in this folder with one of: `.ogg .opus .mp3 .m4a .webm .wav`.
Safari/iOS does not play Ogg Opus in every version: prefer `.m4a` (AAC) or
`.mp3` if you only ship one format.

| Name | When it plays | What to record | Length | Level |
|---|---|---|---|---|
| `surprise` | 30 ms after the lights come on | 5 to 8 friends shouting "เซอร์ไพรส์!" a little ragged, then laughing / "เย้!" and clapping | 1.5 to 2.5 s | peaks around -6 dBFS, no hard click at the start |
| `cheer` | the finale, after the last candle goes out | "เย้!" + applause + laughter, the same group | 2 to 3 s | about -8 dBFS peak |
| `whisper` | 0.9 s into the dark room | one close, quiet "ชู่ว..." or a muffled giggle | under 1 s | very quiet (about -30 dBFS) |

Recording tips: a small room or closet (not a hall), phone at arm's length,
48 kHz, mono is fine (stereo for `surprise` if you have it). Trim silence,
add a 20 ms fade-in, export at 64 to 96 kbps. Keep all three under 250 KB.

## Licence

Only use recordings you made yourself (with the speakers' consent) or files
that are explicitly CC0 / public domain. Add a `CREDITS.md` here with the
source URL, author and licence for anything you did not record.

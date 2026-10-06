# Cat Sound Replier

A fun web page. It listens with the microphone. When it hears a **cat**, it replies fast with a sound.
Human voice is ignored. No login. Live at https://cat.peppasoft.com

## How it works
- Press **Listen**. The browser asks for the microphone.
- Detection uses **YAMNet** (Google, Apache-2.0) running in the browser with TensorFlow.js.
  The model files are in `public/model/` (about 16 MB). No audio leaves the browser.
- The page checks the last ~1 second of sound every 150 ms. It replies as soon as "cat"
  wins over "speech". It does **not** wait for the cat to stop.
- While it plays the reply, and just after, it does not listen (so it does not hear itself).

## Options
| Option | Meaning |
|---|---|
| Detect (top of page) | `Cat sound` (uses the AI model; set **Cat sensitivity** 1-9) or `Any sound` (any sound louder than **Minimum volume**, -70 to -10 dB; reacts at once). The page shows the live dB number to help you set it. |
| Delay before reply | Seconds after the cat sound is detected. Default 1. |
| Wait for silence (checkbox + 1-10 sec) | Off by default. If on, reply after N seconds of silence. The delay is not used then. |
| Play sound mode | `Play specific sound` (pick from the list next to it) or `Repeat received sound` (plays back what the mic heard; no second list). |
| Volume | Reply volume. |

Settings are saved in the browser (localStorage).

## Files
- `public/` - the whole site (static, no backend)
  - `sounds/` - 10 mp3 files + `sounds.json` (the list shown in the page). To add a sound, put an mp3 there and add a line to `sounds.json`.
  - `model/` - YAMNet TF.js model and class map
  - `lib/tf.min.js` - TensorFlow.js 4.22

## Notes
- The microphone needs **HTTPS** (or localhost).
- The speaker can be heard by the mic, but the page ignores its own reply.
- Cat sounds are from Wikimedia Commons. See [CREDITS.md](CREDITS.md).

## Deploy
Server: `ger1` (Virtualmin), user `cat`, domain `cat.peppasoft.com`, docroot `/mnt/ger_hd1/www/cat/public_html`.
Update:
```bash
tar czf /tmp/cat.tgz -C public .
scp /tmp/cat.tgz Ger1-root:/tmp/ && ssh Ger1-root "tar xzf /tmp/cat.tgz -C /mnt/ger_hd1/www/cat/public_html && chown -R cat:cat /mnt/ger_hd1/www/cat/public_html"
```

/**
 * language-guess.js
 * (C) The Hyperaudio Project
 * @version 1.3.21 — last changed in release 1.3.21
 * @license MIT
 *
 * Which language a transcript is in, read from its own words (#662).
 *
 * A project's language is what its engine reported, and often that is
 * nothing: an engine asked to auto-detect says so and no more, and Parakeet
 * (local) never says anything else. Caption generation picks its
 * abbreviations by language, so for those projects "Dr." went on ending
 * sentences. The transcript itself answers the question well enough: every
 * language leans on a few dozen function words, and counting them tells
 * English from German from Spanish long before a page is out.
 *
 * Deliberately modest. It only tells apart the languages listed here — the
 * ones js/caption-abbreviations.js has lists for, which is all the answer is
 * used for — and says '' rather than guess on a short or mixed text. The
 * answer is used at generation and never saved as the project's language: a
 * guess is not a fact about the recording.
 */
(function () {
  const FUNCTION_WORDS = {
    en: 'the and of to a in is that it you for was on with this have are but not we they so what just like',
    de: 'der die und das ist nicht ich zu den mit sich auf für ein eine es wir auch aber dass sie wie im von haben',
    fr: "le la les et des est que un une pas je vous nous dans pour qui sur ce il elle mais avec c'est très ça",
    es: 'el la los las y que de en un una es no por con para se lo pero como más yo muy esto está hay',
    it: 'il la di che e è un una per non in con sono ma come anche più questo si lo gli le della del ho',
    pt: 'o a de que e do da em um uma para não com é os as por mais mas como eu você isso está foi',
    nl: 'de het een en van ik te dat die in is niet zijn op met voor maar er wat ook we je dit naar heb',
  };
  const SETS = Object.keys(FUNCTION_WORDS).map((code) => [code, new Set(FUNCTION_WORDS[code].split(' '))]);

  const MIN_WORDS = 20;      // below this a count means nothing
  const MIN_SHARE = 0.12;    // function words are a third of ordinary speech; a sixth of that is already a signal
  const MIN_LEAD = 1.3;      // and the winner has to be clearly ahead of its neighbour (es/pt, de/nl)

  function guessLanguage(text) {
    const words = String(text || '').toLowerCase()
      .split(/[^\p{L}'’]+/u).filter((w) => w !== '').slice(0, 2000);
    if (words.length < MIN_WORDS) return '';
    const scores = SETS
      .map(([code, set]) => [code, words.reduce((n, w) => n + (set.has(w.replace('’', "'")) ? 1 : 0), 0) / words.length])
      .sort((a, b) => b[1] - a[1]);
    const [best, second] = scores;
    if (best[1] < MIN_SHARE) return '';
    if (second[1] > 0 && best[1] / second[1] < MIN_LEAD) return '';
    return best[0];
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { guessLanguage };
  if (typeof window !== 'undefined') window.guessTranscriptLanguage = guessLanguage;
})();

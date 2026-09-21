// #662 — a project whose engine recorded no language (auto-detect, Parakeet
// local) still has to find its abbreviations. The transcript says what
// language it is in; this reads it, and says nothing when it cannot tell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { guessLanguage } = createRequire(import.meta.url)('../../js/language-guess.js');

const SAMPLES = {
  en: 'Sure. So to start off, Dr. Ashby, can you just introduce yourself and give us a little insight into, like, your background, your profession, some of your credentials, and where you reside, if you are comfortable, and the organizations that you work for?',
  de: 'Ich denke, dass wir heute über die Frage sprechen, wie sich die Stadt in den letzten Jahren verändert hat, und was das für die Menschen bedeutet, die hier schon lange wohnen und nicht wegziehen wollen.',
  fr: "Je pense que nous devons parler de ce qui se passe dans les écoles, parce que les enfants ne sont pas tous égaux devant la lecture, et que c'est une question qui nous concerne tous dans ce pays.",
  es: 'Creo que lo más importante es que la gente entienda por qué hacemos esto, y que no se trata solo de dinero, sino de una forma de vivir en la ciudad con los vecinos que tenemos.',
  it: 'Penso che la cosa più importante sia capire come sono cambiate le città negli ultimi anni, e che cosa significa per le persone che ci vivono da sempre e non vogliono andare via.',
  pt: 'Eu acho que o mais importante é que as pessoas entendam por que fazemos isso, e que não é só uma questão de dinheiro, mas de como vivemos na cidade com os vizinhos que temos.',
  nl: 'Ik denk dat we vandaag moeten praten over de vraag hoe de stad de laatste jaren is veranderd, en wat dat betekent voor de mensen die hier al lang wonen en niet weg willen.',
};

test('each language it knows is told from the others', () => {
  for (const [code, text] of Object.entries(SAMPLES)) assert.equal(guessLanguage(text), code, code);
});

test('it says nothing when it cannot tell', () => {
  assert.equal(guessLanguage(''), '');
  assert.equal(guessLanguage('Yes. No. Maybe.'), '');                       // too short
  assert.equal(guessLanguage('これは日本語の文章です。'.repeat(30)), '');      // a language it has no words for
  assert.equal(guessLanguage('Miten voin auttaa sinua tänään kun sataa vettä koko päivän eikä kukaan halua lähteä ulos kävelylle ennen iltaa tai huomista aamua'), '');
  // half and half: no clear winner
  assert.equal(guessLanguage(SAMPLES.es + ' ' + SAMPLES.pt), '');
});

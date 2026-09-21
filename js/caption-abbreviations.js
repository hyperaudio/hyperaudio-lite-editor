/**
 * caption-abbreviations.js
 * (C) The Hyperaudio Project
 * @version 1.3.21 — last changed in release 1.3.21
 * @license MIT
 *
 * Words that end in a full stop and never end a sentence, per language (#662).
 * Data only. caption.js is handed the list for the project's language and
 * never reads this file itself; with no list it still recognises dotted
 * abbreviations ("e.g.", "p.m.") and initials by their form.
 *
 * What belongs here is a word no rule can tell from a sentence end: a title
 * before a name, where the next word is capitalised as well ("Dr. Smith"), or
 * — in a language that capitalises its nouns — a dotted abbreviation that a
 * capital may follow mid-sentence ("z.B. Autos").
 *
 * What does not belong: a word that often DOES end a sentence ("etc.", "Jr.",
 * and "No.", which is also a whole sentence). Listing one glues the next
 * sentence onto the caption.
 *
 * Keys are two-letter language codes; "en-GB" is looked up as "en". Case and
 * the trailing full stop are ignored. To add a language, add a line.
 */
window.HyperaudioCaptionAbbreviations = Object.freeze({
  en: ['Dr.', 'Mr.', 'Mrs.', 'Ms.', 'Mx.', 'Prof.', 'St.', 'Rev.', 'Hon.', 'Gen.', 'Col.', 'Capt.', 'Lt.', 'Sgt.', 'Gov.', 'Sen.', 'Rep.', 'Pres.', 'Mt.', 'Ft.', 'vs.'],
  de: ['Dr.', 'Prof.', 'Hr.', 'Fr.', 'St.', 'Nr.', 'bzw.', 'ca.', 'evtl.', 'ggf.', 'inkl.', 'sog.', 'vgl.', 'z.B.', 'd.h.', 'u.a.', 'v.a.', 'i.d.R.'],
  fr: ['M.', 'MM.', 'Me.', 'Dr.', 'Pr.', 'Prof.', 'St.', 'Ste.', 'av.', 'bd.', 'env.', 'cf.'],
  es: ['Sr.', 'Sra.', 'Srta.', 'Dr.', 'Dra.', 'D.', 'Dña.', 'Ud.', 'Uds.', 'Vd.', 'Prof.', 'Profa.', 'Lic.', 'Ing.', 'Av.', 'Avda.', 'núm.', 'pág.'],
  it: ['Sig.', 'Sigg.', 'Dott.', 'Dr.', 'Prof.', 'Ing.', 'Avv.', 'Arch.', 'On.', 'Egr.', 'Gent.', 'S.'],
  pt: ['Sr.', 'Sra.', 'Srta.', 'Dr.', 'Dra.', 'Prof.', 'Profa.', 'Eng.', 'Exmo.', 'Exma.', 'Av.'],
  nl: ['dhr.', 'mevr.', 'mw.', 'dr.', 'prof.', 'ir.', 'ing.', 'drs.', 'mr.', 'St.', 'nr.', 'ca.', 'bijv.', 'o.a.', 'd.w.z.'],
});

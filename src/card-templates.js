/**
 * Name-driven card wording, shared by the creator (to prefill the form) and
 * the link decoder (to rebuild untouched text instead of shipping it).
 *
 * Share links only mark "this field is the template"; the receiver rebuilds
 * the exact same words here from name, sender, relation, belated and the
 * sender's language. That is most of what used to make links long.
 */
import { translations } from './i18n.js';

export const RELATIONS = ['friend', 'partner', 'family', 'colleague'];
export const TEMPLATED_FIELDS = ['title', 'message', 'letterTitle', 'letterBody'];

function tIn(lang, key, vars = {}) {
    const raw = translations[lang]?.[key] ?? translations.en[key] ?? key;
    return raw.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/**
 * @param {{ name: string, sender?: string, relation?: string, belated?: boolean, lang?: string }} p
 * @returns {{ title: string, message: string, letterTitle: string, letterBody: string }}
 */
export function buildTemplates({ name, sender = '', relation = 'friend', belated = false, lang = 'th' }) {
    const work = relation === 'colleague';
    const rel = { friend: 'Friend', partner: 'Partner', family: 'Family', colleague: 'Work' }[relation] || 'Friend';
    const titleKey = work ? (belated ? 'tplTitleWorkBelated' : 'tplTitleWork') : (belated ? 'tplTitleBelated' : 'tplTitle');
    const prefix = belated ? tIn(lang, work ? 'tplMsgBelatedWork' : 'tplMsgBelated') : '';
    let letterBody = tIn(lang, `tplLetter${rel}`, { name });
    if (sender) letterBody += `\n\n${tIn(lang, work ? 'tplLetterSignWork' : 'tplLetterSign', { sender })}`;
    return {
        title: tIn(lang, titleKey, { name }),
        message: prefix + tIn(lang, `tplMsg${rel}`),
        letterTitle: tIn(lang, 'tplLetterTitle', { name }),
        letterBody
    };
}

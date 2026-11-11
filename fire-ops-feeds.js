'use strict';

// Only the three officially designated Emergency WA RSS endpoints are read.
// Their published terms cap access at one request per feed per 5 minutes.
// These feeds are *advisory display data*, never automatic work approval.
const RSS_BASE = 'https://api.emergency.wa.gov.au/v1/rss/';
const FEEDS = Object.freeze({
  bans: `${RSS_BASE}total-fire-bans`,
  danger: `${RSS_BASE}fire-danger-ratings`,
  warnings: `${RSS_BASE}warnings?region=METRO%20SOUTH%20EAST`,
});
const MIN_POLL_MS = 5 * 60 * 1000;
const cache = new Map();

function decodeEntities(raw) {
  return String(raw || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(whole,match)=>{
    const key=match.toLowerCase();
    if (key[0]==='#') {
      const num=key[1]==='x'?parseInt(key.slice(2),16):parseInt(key.slice(1),10);
      return num>0 && num<=0x10ffff && !(num>=0xd800&&num<=0xdfff)?String.fromCodePoint(num):'';
    }
    return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[key] || whole;
  });
}
function rawTag(segment,name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,'i').exec(segment);
  return match?.[1] || '';
}
function cleanText(value) {
  const withoutCdata = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1');
  // Some feeds HTML-encode HTML, so decode before stripping tags twice.
  return decodeEntities(decodeEntities(withoutCdata).replace(/<[^>]*>/g,' '))
    .replace(/\s+/g,' ').trim().slice(0,850);
}
function parseRss(xml) {
  if (typeof xml !== 'string' || !/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml))
    throw new Error('Invalid RSS response');
  const items=[];
  const itemRe=/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m=itemRe.exec(xml))!==null && items.length<300) {
    const item=m[1];
    const title=cleanText(rawTag(item,'title'));
    const description=cleanText(rawTag(item,'description'));
    const rawLink=cleanText(rawTag(item,'link'));
    let link=null;
    try {
      const url=new URL(rawLink);
      if (url.protocol==='https:' && (url.hostname==='emergency.wa.gov.au'||url.hostname.endsWith('.emergency.wa.gov.au')||url.hostname==='dfes.wa.gov.au'||url.hostname.endsWith('.dfes.wa.gov.au'))) link=url.toString();
    } catch {}
    items.push({ title,description,link,published:cleanText(rawTag(item,'pubDate')) });
  }
  const firstItem=xml.search(/<item[\s>]/i);
  const head=firstItem>=0?xml.slice(0,firstItem):xml;
  return { title:cleanText(rawTag(head,'title')),published:cleanText(rawTag(head,'pubDate')),items };
}

async function fetchOne(name,now=Date.now(),get=globalThis.fetch) {
  if (!Object.hasOwn(FEEDS,name)) throw new Error('Unknown feed');
  const previous=cache.get(name);
  if (previous && now-previous.checkedMs < MIN_POLL_MS) return previous.pending || previous.value;
  const pending=(async()=>{
    try {
      const response=await get(FEEDS[name],{
        headers:{'Accept':'application/rss+xml, application/xml, text/xml'},
        redirect:'error',signal:AbortSignal.timeout(9000),
      });
      if (!response.ok) throw new Error(`RSS HTTP ${response.status}`);
      const xml=await response.text();
      if (xml.length>2_000_000) throw new Error('RSS too large');
      const parsed=parseRss(xml);
      return {state:'ok',checkedAt:new Date(now).toISOString(),...parsed};
    } catch (error) {
      return {state:'unavailable',checkedAt:new Date(now).toISOString(),title:name,published:null,items:[]};
    }
  })();
  cache.set(name,{ checkedMs:now,pending,value:null });
  const value=await pending;
  cache.set(name,{checkedMs:now,pending:null,value});
  return value;
}
async function snapshot() {
  const [bans,danger,warnings]=await Promise.all(Object.keys(FEEDS).map(k=>fetchOne(k)));
  // Locality filtering is only a hint; it is never evidence that there is no
  // TFB or incident. Warn the reader if official details need to be opened.
  const armadaleMatches=bans.items.filter(item=>/\b(armadale|forrestdale)\b/i.test(`${item.title} ${item.description}`));
  return {
    source:'Emergency WA / DFES official RSS', site:'Forrestdale',lga:'City of Armadale',
    bans,danger,warnings,armadaleMatches,
    terms:'Feed updates are indicative. Check Emergency WA, DFES, and City of Armadale before work.',
  };
}
module.exports={FEEDS,MIN_POLL_MS,parseRss,fetchOne,snapshot};

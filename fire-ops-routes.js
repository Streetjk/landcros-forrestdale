'use strict';

const db=require('./fire-ops-db');
const feeds=require('./fire-ops-feeds');
const { FireOpsError,validateHotWork,validateStaff,validateExtinguisher }=require('./fire-ops-domain');

function createFireOpsHandler({requireRole,readJson,json,rateLimit,database=db,officialFeeds=feeds}) {
  function sendError(res,error) {
    if (error instanceof FireOpsError) return json(res,error.status,{error:error.code,message:error.message});
    if (error?.code==='23505') return json(res,409,{error:'DUPLICATE_RECORD'});
    if (error?.code==='23503') return json(res,409,{error:'UNKNOWN_REFERENCE'});
    console.error('[fire-ops] request failed:',error?.message||'Unknown error');
    return json(res,503,{error:'FIRE_OPS_UNAVAILABLE'});
  }
  function body(req,res,cb) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))
      return json(res,415,{error:'JSON_REQUIRED'});
    // Cookies are SameSite=Lax. Refuse explicitly cross-origin writes too.
    if (req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host!==req.headers.host)
          return json(res,403,{error:'CROSS_ORIGIN_WRITE_DENIED'});
      } catch { return json(res,403,{error:'CROSS_ORIGIN_WRITE_DENIED'}); }
    }
    readJson(req,(error,value)=>{
      if (error) return json(res,400,{error:'INVALID_JSON'});
      Promise.resolve().then(()=>cb(value)).catch(e=>sendError(res,e));
    });
  }
  return function handleFireOps(req,res,pathname) {
    const match=/^\/api\/sites\/([a-z0-9][a-z0-9-]{1,62})\/fire-ops(?:\/(feed|map|work|staff|extinguishers))?(?:\/([0-9a-fA-F-]{36}))?(?:\/(details))?$/.exec(pathname);
    if (!match) return false;
    const slug=match[1],collection=match[2]||'data',id=match[3],subroute=match[4];
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    if (req.method==='GET' && !id && ['data','map','feed'].includes(collection)) {
      requireRole(req,res,slug,'viewer',()=>{
        const task=collection==='data'?database.list(slug):collection==='map'?database.listMapAssets(slug):officialFeeds.snapshot();
        Promise.resolve(task).then(value=>json(res,200,value)).catch(e=>sendError(res,e));
      });
      return true;
    }
    if (req.method==='POST' && collection==='work' && !id) {
      requireRole(req,res,slug,'viewer',s=>{
        if (rateLimit(req,res,'fire-hot-work',25,3600000)) return;
        body(req,res,v=>database.createWork(slug,validateHotWork(v),s.profileId)
          .then(value=>json(res,201,value)));
      });
      return true;
    }
    if (req.method==='PATCH' && collection==='work' && id && (!subroute || subroute==='details')) {
      requireRole(req,res,slug,'admin',s=>{
        if (rateLimit(req,res,'fire-status',80,3600000)) return;
        body(req,res,v=>(subroute==='details'
          ? database.updateWorkDetails(slug,id,validateHotWork(v),s.profileId)
          : database.updateWorkStatus(slug,id,v,s.profileId))
          .then(value=>json(res,200,value)));
      });
      return true;
    }
    if (req.method==='POST' && !id && ['staff','extinguishers'].includes(collection)) {
      requireRole(req,res,slug,'admin',s=>{
        if (rateLimit(req,res,'fire-register',70,3600000)) return;
        body(req,res,v=>{
          const item=collection==='staff'?validateStaff(v):validateExtinguisher(v);
          return database.upsert(slug,collection==='staff'?'staff':'extinguisher',item,s.profileId)
            .then(value=>json(res,200,value));
        });
      });
      return true;
    }
    json(res,405,{error:'METHOD_NOT_ALLOWED'});
    return true;
  };
}
module.exports={createFireOpsHandler};

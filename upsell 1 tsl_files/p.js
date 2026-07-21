(function(){
  "use strict";
  var W = window, D = document, LS = null;
  try { LS = W.localStorage; } catch(e){}
  var COLLECTOR = "https://st.stitchfy.io";
  var Q = (W.stf && W.stf.q) || [];      // fila do snippet (chamadas antes do load)
  var CFG = { siteId: null, consent: true };
  var VKEY = "_stfy_v", CKEY = "_stfy_c";  // cookie do visitor_id + do consent

  // ---- util ----
  function uuid(){ try { return (W.crypto&&W.crypto.randomUUID)?W.crypto.randomUUID():
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c=="x"?r:(r&0x3|0x8);return v.toString(16);}); }
    catch(e){ return String(Date.now())+Math.random().toString(16).slice(2); } }
  function getCookie(n){ try { var m=D.cookie.match("(^|;)\\s*"+n+"\\s*=\\s*([^;]+)"); return m?decodeURIComponent(m.pop()):null; } catch(e){ return null; } }
  function setCookie(n,v,days){ try {
    var d=new Date(); d.setTime(d.getTime()+(days*864e5));
    // domínio raiz (eTLD+1) p/ o cookie valer em subdomínios (loja + checkout mesmo domínio)
    var host=D.location.hostname, parts=host.split("."), root=parts.length>1?"."+parts.slice(-2).join("."):host;
    D.cookie=n+"="+encodeURIComponent(v)+";path=/;max-age="+(days*86400)+";domain="+root+";SameSite=Lax"+(D.location.protocol=="https:"?";Secure":"");
  } catch(e){} }
  function store(k,v){ try{ if(LS) LS.setItem(k,v); }catch(e){} }
  function load(k){ try{ return LS?LS.getItem(k):null; }catch(e){ return null; } }

  // ---- visitor_id durável (Cookie Keeper: re-seta o cookie a cada carga p/ estender TTL sob ITP) ----
  function visitorId(){
    var v = getCookie(VKEY) || load(VKEY);
    if(!v){ v = uuid(); }
    setCookie(VKEY, v, 365); store(VKEY, v);   // renova sempre = Cookie Keeper
    return v;
  }

  // ---- params que a gente captura (click-ids + UTMs padrão/custom + afiliado BR) ----
  var CLICK_IDS = ["gclid","gbraid","wbraid","fbclid","ttclid","tbclid","msclkid","click_id","clickid"];
  var AFFIL = ["xcod","sck","cid","src","campaignid","adsetid","creativeid","pixel_id","keyword"];
  function qp(){ try { var o={}, sp=new URLSearchParams(D.location.search);
    sp.forEach(function(val,key){ o[key.toLowerCase()]=val; }); return o; } catch(e){ return {}; } }
  // #40 WhatsApp: recupera a campanha ESCONDIDA como zero-width chars num valor de query ou no referrer
  // (invisível na barra, preservada pelo browser). Espelha decodeCampaign() do worker/collector/whatsapp-codec.
  // SENT=U+2060 (sentinela), BIT0=U+200B, BIT1=U+200C. Retorna null se não houver run bem-formado. Nunca quebra.
  function waCampaign(){
    try {
      var SENT=String.fromCharCode(0x2060), B0=String.fromCharCode(0x200B), B1=String.fromCharCode(0x200C);
      var hay; try { hay=decodeURIComponent(D.location.search); } catch(e){ hay=D.location.search; }
      hay += " " + (D.referrer||"");
      var s=hay.indexOf(SENT); if(s<0) return null;
      var e=hay.indexOf(SENT, s+1); if(e<=s+1) return null;
      var run=hay.slice(s+1,e), bits="", i;
      for(i=0;i<run.length;i++){ var c=run.charAt(i);
        if(c===B0) bits+="0"; else if(c===B1) bits+="1"; else return null; }   // glyph não-bit no run → malformado
      if(!bits.length || bits.length%8!==0) return null;
      var bytes=[], j; for(j=0;j<bits.length;j+=8){ bytes.push(parseInt(bits.slice(j,j+8),2)); }
      try { var t=new TextDecoder().decode(new Uint8Array(bytes)); return t.indexOf(String.fromCharCode(0xFFFD))<0 ? t : null; }
      catch(e2){ return null; }
    } catch(e){ return null; }
  }
  // Extrai o pacote de atribuição da URL atual (o que vale a pena persistir + propagar).
  function attrFromUrl(){
    var p = qp(), out = { utm:{}, custom:{}, click:{}, affil:{} }, k;
    for(k in p){ if(!p.hasOwnProperty(k)) continue;
      if(k.indexOf("utm_")===0){ out.utm[k]=p[k]; }               // TODAS as utm_* (padrão + custom)
      else if(CLICK_IDS.indexOf(k)>=0){ out.click[k]=p[k]; }
      else if(AFFIL.indexOf(k)>=0){ out.affil[k]=p[k]; }
    }
    // BACKUP-PARAM click-id restore (técnica do Stape): o anúncio carrega backup_<id>={id} no Final URL
    // suffix, então a URL chega com o click-id nativo E o backup. Quando o Safari/iOS/Brave strippa o
    // nativo (ITP), o backup sobrevive → restauramos o click-id do backup (marcando 'restored' pra freshness).
    // CONTRATO (não mudar sem atualizar dashboard/src/pixel-sdk-propagation.test.ts):
    //  1. nativo SEMPRE ganha — o backup só entra quando o click-id nativo está ausente/vazio; a decisão é
    //     independente por id (gclid nativo + fbclid restaurado convivem no mesmo pageview);
    //  2. backup vazio (backup_gclid=) NÃO restaura — jamais fabricamos um click-id;
    //  3. como o restore acontece AQUI DENTRO de attrFromUrl() — o único ponto de extração — o id restaurado
    //     pega carona nos TRÊS trilhos na ordem certa: persistência (persistTouch em boot/track), propagação
    //     (decorateLinks/propagableParams) e envio (payload → attribution.click), idêntico a um nativo;
    //  4. o mapa out.restored viaja dentro do first/last-touch persistido (honestidade: o servidor consegue
    //     distinguir) — a flag 'restored' de 1ª classe no backend/hidratação é Wave 2, fora deste arquivo.
    // Recupera ~2% de cliques que seriam perdidos.
    for(var ci=0; ci<CLICK_IDS.length; ci++){ var cid=CLICK_IDS[ci];
      if(!out.click[cid] && p["backup_"+cid]){
        out.click[cid] = p["backup_"+cid];
        (out.restored = out.restored || {})[cid] = true;
      }
    }
    // #40: se a campanha veio ofuscada por WhatsApp e não há utm_campaign explícita, dobra na trilha utm
    // (assim é persistida em first/last-touch, propagada aos links do checkout e enviada no payload — DRY).
    var wa = waCampaign();
    if(wa && !out.utm.utm_campaign){
      out.utm.utm_source = out.utm.utm_source || "whatsapp";
      out.utm.utm_medium = out.utm.utm_medium || "whatsapp";
      out.utm.utm_campaign = wa;
    }
    return out;
  }
  function isEmpty(o){ for(var k in o){ if(o.hasOwnProperty(k)) return false; } return true; }

  // ---- persistência first-touch / last-touch (só grava se a URL trouxe atribuição nova) ----
  function persistTouch(attr){
    try {
      var hasAny = !isEmpty(attr.utm)||!isEmpty(attr.click)||!isEmpty(attr.affil);
      if(!hasAny) return;
      var now = Date.now();
      var last = { attr: attr, ts: now, ref: D.referrer||null, lp: D.location.href };
      store("_stfy_last", JSON.stringify(last));
      if(!load("_stfy_first")){ store("_stfy_first", JSON.stringify(last)); }
    } catch(e){}
  }
  function readTouch(k){ try { var s=load(k); return s?JSON.parse(s):null; } catch(e){ return null; } }

  // ---- cookies de plataforma p/ match (Meta/Google/Shopify) ----
  function platformCookies(){
    return { _fbp:getCookie("_fbp"), _fbc:getCookie("_fbc"), _ga:getCookie("_ga"),
             _shopify_y:getCookie("_shopify_y"), _shopify_s:getCookie("_shopify_s") };
  }
  // cart_token (Shopify) — tenta cookie e o objeto global comum de checkout
  function cartToken(){ try { return getCookie("cart") || getCookie("checkout") ||
    (W.Shopify&&W.Shopify.checkout&&W.Shopify.checkout.token) || null; } catch(e){ return null; } }

  // ---- flatten dos params p/ propagação nos links ----
  function propagableParams(){
    var attr = attrFromUrl(), first = readTouch("_stfy_first"), out = {};
    // usa a atribuição da URL atual; se a página não tem, cai no first-touch persistido
    var src = (!isEmpty(attr.utm)||!isEmpty(attr.click)||!isEmpty(attr.affil)) ? attr : (first?first.attr:{utm:{},click:{},affil:{}});
    var g=function(bag){ for(var k in bag){ if(bag.hasOwnProperty(k)) out[k]=bag[k]; } };
    g(src.utm||{}); g(src.click||{}); g(src.affil||{});
    out.stfy_vid = visitorId();   // carrega o visitor_id cross-domain pro checkout
    return out;
  }

  // ---- PROPAGAÇÃO: decora <a href>, forms, iframes e window.open com os params ----
  function decorateUrl(url, params){
    try {
      var u = new URL(url, D.location.href);
      // só decora http(s) — pula tel:/mailto:/#/javascript:
      if(u.protocol!=="http:"&&u.protocol!=="https:") return url;
      for(var k in params){ if(params.hasOwnProperty(k) && params[k]!=null && !u.searchParams.has(k)) u.searchParams.set(k, params[k]); }
      return u.toString();
    } catch(e){ return url; }
  }
  function decorateLinks(){
    try {
      var params = propagableParams();
      if(isEmpty(params)) return;
      var as = D.getElementsByTagName("a"), i;
      for(i=0;i<as.length;i++){ var a=as[i]; if(a.href && !a.hasAttribute("data-stfy-skip")) a.href=decorateUrl(a.href, params); }
      var fs = D.getElementsByTagName("form");
      for(i=0;i<fs.length;i++){ var f=fs[i];
        if(f.method && f.method.toLowerCase()==="get" && f.action){ f.action=decorateUrl(f.action, params); }
        else { for(var k in params){ if(params.hasOwnProperty(k) && !f.querySelector('[name="'+k+'"]')){
          var inp=D.createElement("input"); inp.type="hidden"; inp.name=k; inp.value=params[k]; f.appendChild(inp); } } }
      }
      var ifr = D.getElementsByTagName("iframe");
      for(i=0;i<ifr.length;i++){ var fr=ifr[i]; if(fr.src) try{ fr.src=decorateUrl(fr.src, params); }catch(e){} }
    } catch(e){}
  }
  // intercepta window.open p/ carregar os params (checkout aberto em nova aba)
  function hookWindowOpen(){
    try { var orig=W.open; W.open=function(url){ try{ if(url) arguments[0]=decorateUrl(url, propagableParams()); }catch(e){} return orig.apply(W, arguments); }; } catch(e){}
  }

  // ---- ENVIO ----
  function payload(name, extra){
    var attr = attrFromUrl();
    var base = {
      site_id: CFG.siteId,
      event: { name: name, id: uuid(), data: (extra&&extra.data)||{} },
      event_name: name,
      occurred_at: new Date().toISOString(),
      visitor: { clientId: visitorId() },
      consent: CFG.consent,
      page: { href: D.location.href, path: D.location.pathname, title: D.title, referrer: D.referrer||null },
      attribution: { utm: attr.utm, click: attr.click, affil: attr.affil,
                     first: readTouch("_stfy_first"), last: readTouch("_stfy_last") },
      cookies: platformCookies(),
      cart_token: cartToken(),
      device: { ua: navigator.userAgent, lang: navigator.language, tz: (Intl&&Intl.DateTimeFormat)?Intl.DateTimeFormat().resolvedOptions().timeZone:null,
                vw: W.innerWidth, vh: W.innerHeight, sw: screen.width, sh: screen.height }
    };
    if(extra){ for(var k in extra){ if(extra.hasOwnProperty(k) && k!=="data") base[k]=extra[k]; } }
    return base;
  }
  var QUEUE = [];
  function endpoint(){ return COLLECTOR + "/e?s=" + encodeURIComponent(CFG.siteId||""); }
  function flush(useBeacon){
    if(!CFG.siteId || QUEUE.length===0) return;
    var items = QUEUE.splice(0, QUEUE.length);
    for(var i=0;i<items.length;i++){ (function(body){
      var json = JSON.stringify(body);
      try {
        // text/plain nos DOIS canais → "simple request" (sem preflight CORS). O corpo continua sendo
        // JSON; o servidor lê os bytes (arrayBuffer) e parseia agnóstico ao content-type.
        if(useBeacon && navigator.sendBeacon){ navigator.sendBeacon(endpoint(), new Blob([json],{type:"text/plain;charset=UTF-8"})); return; }
        fetch(endpoint(), { method:"POST", credentials:"include", keepalive:true, headers:{"content-type":"text/plain;charset=UTF-8"}, body:json })
          ["catch"](function(){ QUEUE.push(body); }); // falha de rede → re-enfileira
      } catch(e){ try{ if(navigator.sendBeacon) navigator.sendBeacon(endpoint(), json); }catch(e2){} }
    })(items[i]); }
  }
  function track(name, extra){ try {
    if(!name) return;
    QUEUE.push(payload(name, extra));
    persistTouch(attrFromUrl());
    flush(false);
  } catch(e){} }

  // ---- COMPORTAMENTO ----
  var maxScroll = 0, engagedMs = 0, lastActive = Date.now(), scrollSent = {};
  function onScroll(){ try {
    var h=D.documentElement, b=D.body, st=h.scrollTop||b.scrollTop, sh=(h.scrollHeight||b.scrollHeight)-h.clientHeight;
    var pct = sh>0 ? Math.min(100, Math.round(st/sh*100)) : 0;
    if(pct>maxScroll) maxScroll=pct;
    [25,50,75,90].forEach(function(mk){ if(maxScroll>=mk && !scrollSent[mk]){ scrollSent[mk]=1; track("scroll_depth",{data:{percent:mk}}); } });
  } catch(e){} }
  function onClick(e){ try {
    var t=e.target; while(t && t!==D.body){
      if(t.tagName==="A" || t.tagName==="BUTTON" || (t.getAttribute&&t.getAttribute("role")==="button")){
        var txt=(t.innerText||t.textContent||"").trim().slice(0,120);
        track("cta_click", { data:{ button_text:txt, link_url: t.href||null, tag:t.tagName } });
        break;
      } t=t.parentNode;
    }
  } catch(e){} }
  function tickEngage(){ if(Date.now()-lastActive < 30000) engagedMs += 5000; }
  ["mousemove","keydown","scroll","touchstart"].forEach(function(ev){ try{ D.addEventListener(ev,function(){lastActive=Date.now();},{passive:true}); }catch(e){} });

  // SPA: re-dispara PageView + re-decora nas trocas de rota
  function hookSpa(){ try {
    var fire=function(){ setTimeout(function(){ decorateLinks(); track("page_viewed"); }, 30); };
    var ps=history.pushState; history.pushState=function(){ var r=ps.apply(this,arguments); fire(); return r; };
    var rs=history.replaceState; history.replaceState=function(){ var r=rs.apply(this,arguments); fire(); return r; };
    W.addEventListener("popstate", fire);
  } catch(e){} }

  // ---- API pública (stf('init',siteId) / stf('track',name,data) / stf('consent',bool)) ----
  function exec(args){ try {
    var cmd=args[0];
    if(cmd==="init"){ CFG.siteId=args[1]; if(args[2]&&typeof args[2]==="object"){ if("consent" in args[2]) CFG.consent=!!args[2].consent; } }
    else if(cmd==="track"){ track(args[1]||"custom", args[2]?{data:args[2]}:undefined); }
    else if(cmd==="consent"){ CFG.consent=!!args[1]; try{ setCookie(CKEY, CFG.consent?"1":"0", 365); }catch(e){} }
    else if(cmd==="identify" && args[1]){ track("identify", { data:{ has_email: !!args[1].email, has_phone: !!args[1].phone } }); } // hash real = Fase C
  } catch(e){} }

  // replaya a fila do snippet e vira a função síncrona
  function boot(){
    for(var i=0;i<Q.length;i++){ exec(Q[i]); }
    W.stf = function(){ exec([].slice.call(arguments)); };
    W.stf.q = [];
    // consent persistido
    var pc=getCookie(CKEY); if(pc!=null) CFG.consent = pc==="1";
    // captura + propagação + comportamento
    persistTouch(attrFromUrl());
    decorateLinks(); hookWindowOpen(); hookSpa();
    try { D.addEventListener("scroll", onScroll, {passive:true}); D.addEventListener("click", onClick, true); } catch(e){}
    setInterval(tickEngage, 5000);
    // re-decora quando o DOM muda (links carregados depois)
    try { if(W.MutationObserver){ var mo=new MutationObserver(function(){ decorateLinks(); }); mo.observe(D.documentElement,{childList:true,subtree:true}); } } catch(e){}
    // envia engajamento + flush no fim
    W.addEventListener("visibilitychange", function(){ if(D.visibilityState==="hidden"){ track("engagement",{data:{engaged_ms:engagedMs, max_scroll:maxScroll}}); flush(true); } });
    W.addEventListener("pagehide", function(){ flush(true); });
    // PageView inicial (se o snippet não disparou um)
    if(CFG.siteId) track("page_viewed");
  }
  if(D.readyState==="loading"){ D.addEventListener("DOMContentLoaded", boot); } else { boot(); }
})();
const PRODUCT={id:'ultimate-video-ai-mastery',offerPrice:'29.99',regularPrice:'49.99',currency:'USD'};
const CONSENT_KEY='formumax-advertising-consent',PENDING_KEY='formumax-pending-checkout';
const PAYMENT_ID=/^[A-Z0-9]{10,32}$/;
let configPromise,configCache,configTime=0,paypalLoading,checkoutLoading,createLoading,captureLoading;
let offerTimer,serverOffset=0,nextExpiryRefresh=0,acceptedOrder=null,clickedPrice=null,pricingNotice='',lastDisplayedPrice=null;
let rendered=false,trackingStarted=false,trackingLoading,termsListener;

export function getConsent(){try{if(navigator.globalPrivacyControl)return false;const c=localStorage.getItem(CONSENT_KEY);return c==='yes'?true:c==='no'?false:null;}catch{return false;}}
function revokeTracking(){
  if(window.fbq)window.fbq('consent','revoke');
  for(const name of ['_fbp','_fbc']){
    document.cookie=`${name}=; Max-Age=0; Path=/; Secure; SameSite=Lax`;
    const parts=location.hostname.split('.');
    for(let i=0;i<parts.length-1;i++)document.cookie=`${name}=; Max-Age=0; Path=/; Domain=.${parts.slice(i).join('.')}; Secure; SameSite=Lax`;
  }
}
export function setConsent(value){try{localStorage.setItem(CONSENT_KEY,value?'yes':'no');}catch{}if(!value||navigator.globalPrivacyControl)revokeTracking();}
window.addEventListener('storage',e=>{if(e.key===CONSENT_KEY&&getConsent()!==true)revokeTracking();});

async function api(url,{body,timeout=15000}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const r=await fetch(url,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    let data;try{data=await r.json();}catch{throw Error('The checkout service returned an unexpected response. Please retry.');}
    if(!r.ok){const e=Error(data.error?.message||'Unable to complete checkout. Please try again or contact support.');e.code=data.error?.code;e.status=r.status;throw e;}
    return data;
  }catch(e){
    if(e.name==='AbortError'||e instanceof TypeError){const error=Error('The connection was interrupted. Retry verification if you approved a payment; do not place another order.');error.code='CONNECTION_INTERRUPTED';throw error;}
    throw e;
  }finally{clearTimeout(timer);}
}
// Historical server-verified orders and receipts retain their accepted total.
function validPrice(price){return [PRODUCT.offerPrice,PRODUCT.regularPrice,'19.00','29.00','99.00'].includes(price);}
function formatPrice(price){const amount=Number(price);return `$${amount.toFixed(Number.isInteger(amount)?0:2)}`;}
function currentPrice(){return configCache?.offerActive&&Date.parse(configCache.offerExpiresAt)>Date.now()+serverOffset?PRODUCT.offerPrice:PRODUCT.regularPrice;}
function checkoutPrice(){return acceptedOrder?.price||currentPrice();}
function assertProduct(data){if(!data||!validPrice(data.price)||data.currency!==PRODUCT.currency)throw Error('The checkout details have changed. Please refresh the page before continuing.');}
function updateOfferDisplay(){
  if(!configCache)return;
  const remaining=Math.max(0,Date.parse(configCache.offerExpiresAt)-(Date.now()+serverOffset));
  const active=configCache.offerActive&&remaining>0,price=active?PRODUCT.offerPrice:PRODUCT.regularPrice;
  if(lastDisplayedPrice===PRODUCT.offerPrice&&price===PRODUCT.regularPrice&&!acceptedOrder){
    const terms=document.querySelector('#purchase-terms');if(terms?.checked){terms.checked=false;termsListener?.();}
    status(`Your promotional window has ended. Review the US${formatPrice(PRODUCT.regularPrice)} total and confirm the purchase terms to continue.`);
  }
  lastDisplayedPrice=price;
  for(const node of document.querySelectorAll?.('[data-course-price]')||[]){node.textContent=formatPrice(node.closest?.('#checkout-dialog')?checkoutPrice():price);node.classList?.toggle('price-unavailable',false);}
  for(const node of document.querySelectorAll?.('[data-promo-only]')||[])node.hidden=!active;
  const seconds=active?Math.ceil(remaining/1000):0;
  const countdown=[Math.floor(seconds/3600),Math.floor(seconds%3600/60),seconds%60].map(n=>String(n).padStart(2,'0')).join(':');
  for(const node of document.querySelectorAll?.('[data-promo-countdown]')||[])node.textContent=countdown;
  for(const node of document.querySelectorAll?.('[data-promo-label]')||[])node.textContent=active?'Your 5-hour offer':'Regular price';
  const total=document.querySelector('.checkout-total b');
  if(total&&!total.matches?.('[data-course-price]')&&!total.querySelector?.('[data-course-price]'))total.textContent=`US${formatPrice(checkoutPrice())}`;
  let note=document.querySelector('#checkout-order-price');
  if(acceptedOrder&&acceptedOrder.price!==price&&document.querySelector('#paypal-buttons')){
    if(!note){note=document.createElement('p');note.id='checkout-order-price';note.className='checkout-explain';document.querySelector('#checkout-content')?.appendChild(note);}
    note.textContent=`Your existing PayPal order remains US${formatPrice(acceptedOrder.price)}. The accepted order total is shown at PayPal.`;
  }else note?.remove();
  if(configCache.offerActive&&!active&&Date.now()>=nextExpiryRefresh){nextExpiryRefresh=Date.now()+30000;void config(true).catch(()=>{});}
}
async function config(refresh=false){
  // A single in-flight request initializes the signed visitor cookie even when
  // price display, analytics and checkout start together.
  if(configPromise)return configPromise;
  if(!refresh&&configCache&&Date.now()-configTime<300000)return configCache;
  configPromise=api('/api/config').then(data=>{
    assertProduct(data);
    if(data.productId!==PRODUCT.id||typeof data.checkoutAvailable!=='boolean'||data.regularPrice!==PRODUCT.regularPrice||data.offerPrice!==PRODUCT.offerPrice||typeof data.offerActive!=='boolean'||!Number.isFinite(Date.parse(data.serverTime))||(data.offerActive&&!Number.isFinite(Date.parse(data.offerExpiresAt))))throw Error('The course checkout could not be verified. Please contact support.');
    if(data.price!==(data.offerActive?PRODUCT.offerPrice:PRODUCT.regularPrice))throw Error('The checkout price could not be verified.');
    if(data.acceptedOrder){assertProduct(data.acceptedOrder);if(!PAYMENT_ID.test(data.acceptedOrder.orderId||''))throw Error('The accepted order could not be verified.');}
    configCache=data;configTime=Date.now();serverOffset=Date.parse(data.serverTime)-Date.now();acceptedOrder=data.acceptedOrder||null;updateOfferDisplay();return data;
  }).finally(()=>{configPromise=undefined;});
  return configPromise;
}
function showOfferUnavailable(){
  if(configCache)return;
  for(const node of document.querySelectorAll?.('[data-course-price]')||[]){node.textContent='Check price';node.classList?.toggle('price-unavailable',true);}
  for(const node of document.querySelectorAll?.('[data-promo-only]')||[])node.hidden=true;
  for(const node of document.querySelectorAll?.('[data-promo-label]')||[])node.textContent='Price confirmed at checkout';
}
function refreshOfferOnReturn(){
  if(document.hidden)return;
  return config().then(updateOfferDisplay).catch(showOfferUnavailable);
}
export async function initOffer(){
  if(!offerTimer){
    offerTimer=setInterval(updateOfferDisplay,1000);offerTimer.unref?.();
    document.addEventListener('visibilitychange',refreshOfferOnReturn);window.addEventListener('focus',refreshOfferOnReturn);
  }
  try{await config();updateOfferDisplay();}catch{showOfferUnavailable();}
  return ()=>{clearInterval(offerTimer);offerTimer=undefined;document.removeEventListener('visibilitychange',refreshOfferOnReturn);window.removeEventListener('focus',refreshOfferOnReturn);};
}
export async function initTracking(){
  if(getConsent()!==true)return;
  if(trackingStarted&&window.fbq){window.fbq('consent','grant');return;}
  if(trackingLoading)return trackingLoading;
  trackingLoading=(async()=>{
    const c=await config();if(getConsent()!==true||!/^\d+$/.test(c.pixelId||''))return;
    if(!window.fbq){const q=function(){q.callMethod?q.callMethod.apply(q,arguments):q.queue.push(arguments)};q.push=q;q.loaded=true;q.version='2.0';q.queue=[];window.fbq=q;window._fbq=q;const s=document.createElement('script');s.async=true;s.src='https://connect.facebook.net/en_US/fbevents.js';document.head.appendChild(s);}
    window.fbq('consent','grant');window.fbq('init',c.pixelId);trackingStarted=true;window.fbq('track','PageView');
    if(location.pathname.replace(/\/$/,'')==='/ultimatevideoaimastery')track('ViewContent');
  })().catch(()=>{trackingStarted=false;}).finally(()=>{trackingLoading=undefined;});
  return trackingLoading;
}
export function track(event,eventID,paidPrice){
  if(getConsent()!==true||!window.fbq||!['ViewContent','InitiateCheckout','AddPaymentInfo','Purchase'].includes(event))return false;
  if(event==='Purchase'&&!validPrice(paidPrice))return false;
  const price=event==='Purchase'?paidPrice:event==='ViewContent'?currentPrice():checkoutPrice();
  window.fbq('track',event,{content_ids:[PRODUCT.id],content_type:'product',content_name:'Ultimate AI Video Mastery',currency:PRODUCT.currency,value:Number(price)},eventID?{eventID}:undefined);return true;
}
function cookie(name){return document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);}
function status(message,error=false){const p=document.querySelector('#checkout-status');if(p){p.textContent=message;p.classList.toggle('error',error);}}
function readPending(){try{const p=JSON.parse(localStorage.getItem(PENDING_KEY)||'null');return p&&PAYMENT_ID.test(p.orderId)&&Number.isFinite(p.approvedAt)?p:null;}catch{return null;}}
function savePending(orderId){const old=readPending();try{localStorage.setItem(PENDING_KEY,JSON.stringify(old?.orderId===orderId?old:{orderId,price:acceptedOrder?.price,approvedAt:Date.now()}));}catch{}}
function retryButton(label,action){
  document.querySelector('#checkout-retry')?.remove();const b=document.createElement('button');b.id='checkout-retry';b.type='button';b.className='button primary';b.textContent=label;
  b.onclick=async()=>{b.disabled=true;try{await action();}catch(e){status(e.message,true);}finally{b.disabled=false;}};
  document.querySelector('#checkout-content')?.appendChild(b);
}
async function recordPurchase(data){
  if(getConsent()!==true)return;await initTracking();const key=`formumax-purchase-${data.captureId}`;
  try{if(!localStorage.getItem(key)&&track('Purchase',data.eventId,data.price))localStorage.setItem(key,'sent');}catch{track('Purchase',data.eventId,data.price);}
}
async function showAccess(data,{purchaseEvent=false}={}){
  assertProduct(data);
  if(!PAYMENT_ID.test(data.orderId||'')||!PAYMENT_ID.test(data.captureId||'')||data.eventId!==`purchase_${data.captureId}`)throw Error('Your payment receipt could not be verified. Please contact support with your PayPal transaction ID.');
  let url;try{url=new URL(data.notionUrl);if(url.protocol!=='https:'||url.username||url.password||!['notion.so','notion.site'].some(h=>url.hostname===h||url.hostname.endsWith('.'+h)))throw Error();}catch{throw Error('Your course link could not be verified. Please contact support; do not pay again.');}
  const target=document.querySelector('#checkout-content');if(!target)return;
  const eyebrow=document.createElement('p');eyebrow.className='eyebrow';eyebrow.textContent='PAYMENT CONFIRMED';
  const heading=document.createElement('h2');heading.id='checkout-title';heading.textContent='Your next scene starts now.';
  const desc=document.createElement('p');desc.textContent='Your English playbook is ready. Open the Notion course and begin with Start Here. Save the course link for future access.';
  const link=document.createElement('a');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';link.className='button primary access-link';link.textContent='Open your course in Notion ↗';
  const receipt=document.createElement('p');receipt.className='access-success';receipt.textContent=`Paid US${formatPrice(data.price)} · PayPal transaction: ${data.captureId}`;
  const support=document.createElement('p'),email=document.createElement('a');email.href='mailto:achaer31@gmail.com';email.textContent='achaer31@gmail.com';support.append('Need help? Email ',email,' with your transaction ID. Your PayPal receipt confirms your payment; save the course link from this screen.');
  target.replaceChildren(eyebrow,heading,desc,link,receipt,support);rendered=true;
  try{if(readPending()?.orderId===data.orderId)localStorage.removeItem(PENDING_KEY);}catch{}
  history.replaceState({},'','/ultimatevideoaimastery/access');
  // Reopening old course access is not a new advertising conversion.
  if(purchaseEvent)await recordPurchase(data);
}
async function loadPayPal(clientId){
  if(typeof window.paypal?.Buttons==='function')return;
  if(!paypalLoading)paypalLoading=new Promise((resolve,reject)=>{
    const s=document.createElement('script');let done=false;
    const fail=()=>{if(done)return;done=true;clearTimeout(timer);paypalLoading=undefined;s.remove();reject(Error('PayPal could not load. Check your connection, then select Retry secure checkout.'));};
    const timer=setTimeout(fail,20000);
    s.src=`https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${PRODUCT.currency}&intent=capture&components=buttons&disable-funding=paylater`;s.async=true;
    s.onload=()=>{if(done)return;if(typeof window.paypal?.Buttons!=='function'){fail();return;}done=true;clearTimeout(timer);resolve();};s.onerror=fail;document.head.appendChild(s);
  });
  return paypalLoading;
}
async function confirmPayment(orderId){
  if(!PAYMENT_ID.test(orderId||''))throw Error('The PayPal payment reference is invalid. Please contact support.');
  if(captureLoading)return captureLoading;const consent=getConsent()===true;
  captureLoading=(async()=>{status('Confirming your payment. Please keep this window open…');const paid=await api('/api/capture',{body:{orderId,consent},timeout:60000});await showAccess(paid,{purchaseEvent:consent});return paid;})().finally(()=>{captureLoading=undefined;});return captureLoading;
}
function paymentRetry(orderId,error){status(`${error.message} If you see a charge, do not pay again. Keep your PayPal receipt or contact support.`,true);retryButton('Retry payment verification',()=>confirmPayment(orderId));}
async function restoreAccess(accessOnly){
  const pending=readPending();
  try{const data=await api('/api/access',{timeout:45000});const recent=pending?.orderId===data.orderId&&Date.now()-pending.approvedAt<7200000;await showAccess(data,{purchaseEvent:Boolean(recent)});return true;}
  catch(e){if(e.code!=='ACCESS_REQUIRED'){status(e.message,true);retryButton('Check access again',()=>initCheckout(accessOnly));return true;}}
  if(pending){
    // Recovery stores only a payment reference from PayPal's approval callback.
    // The backend still requires a valid signed checkout cookie and verifies PayPal.
    try{await confirmPayment(pending.orderId);}catch(e){paymentRetry(pending.orderId,e);}return true;
  }
  if(accessOnly){status('We could not find an active purchase in this browser. If you already paid, use your saved course link or email support with your PayPal transaction ID. Do not pay again.',true);retryButton('Check access again',()=>initCheckout(true));return true;}
  return false;
}
async function prepareCheckout(accessOnly){
  document.querySelector('#checkout-retry')?.remove();status(accessOnly?'Checking your payment and access…':'Preparing secure PayPal checkout…');
  const c=await config(true);if(!c.checkoutAvailable||typeof c.paypalClientId!=='string'||!c.paypalClientId)throw Error('Checkout is being prepared. Please contact support before making a payment.');
  if(await restoreAccess(accessOnly))return;await loadPayPal(c.paypalClientId);
  const terms=document.querySelector('#purchase-terms');if(!terms)throw Error('Please refresh this page to reopen checkout.');
  const buttons=window.paypal.Buttons({
    style:{layout:'vertical',shape:'rect',color:'gold',label:'paypal',height:46},
    onInit(data,actions){if(termsListener)terms.removeEventListener('change',termsListener);termsListener=()=>terms.checked?actions.enable():actions.disable();terms.addEventListener('change',termsListener);termsListener();status('Confirm the purchase terms above to continue securely with PayPal.');},
    onClick(data,actions){if(!terms.checked){status('Please confirm the purchase terms to continue.',true);return actions.reject?.();}pricingNotice='';clickedPrice=checkoutPrice();track('AddPaymentInfo');return actions.resolve?.();},
    async createOrder(){
      if(!terms.checked)throw Error('Please confirm the purchase terms to continue.');if(createLoading)return createLoading;
      const displayedPrice=clickedPrice||checkoutPrice();
      createLoading=(async()=>{
        const fresh=await config(true);if(!fresh.checkoutAvailable||fresh.paypalClientId!==c.paypalClientId)throw Error('Checkout has been updated. Please refresh this page.');
        if(displayedPrice!==checkoutPrice()){const e=Error(`The checkout total is now US${formatPrice(checkoutPrice())}. Please review the updated price and confirm the terms again.`);e.code='PRICE_CHANGED';throw e;}
        status('Creating your secure order…');const consent=getConsent()===true;
        const data=await api('/api/orders',{body:{productId:PRODUCT.id,expectedPrice:checkoutPrice(),consent,...(consent?{fbp:cookie('_fbp'),fbc:cookie('_fbc')}:{})},timeout:45000});
        assertProduct(data);if(!PAYMENT_ID.test(data.orderId||''))throw Error('The PayPal order could not be verified. Please retry.');acceptedOrder=data;updateOfferDisplay();return data.orderId;
      })().catch(async e=>{
        if(e.code==='PRICE_CHANGED'){await config(true).catch(()=>{});terms.checked=false;termsListener?.();pricingNotice=e.message;clickedPrice=null;status(e.message,true);}
        throw e;
      }).finally(()=>{createLoading=undefined;});return createLoading;
    },
    async onApprove(data,actions){
      if(!PAYMENT_ID.test(data.orderID||'')){status('The PayPal reference could not be verified. Please contact support.',true);return;}
      savePending(data.orderID);try{await confirmPayment(data.orderID);}catch(e){
        if(e.code==='PAYMENT_DECLINED'){try{localStorage.removeItem(PENDING_KEY);}catch{}status('Your payment method was declined. Please choose another method.',true);return actions.restart();}
        paymentRetry(data.orderID,e);
      }
    },
    onCancel(){status('Payment cancelled. You can try again when ready.');},
    onError(){if(pricingNotice){status(pricingNotice,true);return;}const pending=readPending();if(pending){paymentRetry(pending.orderId,Error('PayPal could not finish payment verification.'));return;}status('PayPal could not finish checkout. If you were charged, do not pay again; contact support. Otherwise, close this window and retry.',true);}
  });
  try{await buttons.render('#paypal-buttons');rendered=true;}catch(e){try{await buttons.close?.();}catch{}document.querySelector('#paypal-buttons')?.replaceChildren();throw e;}
}
export async function initCheckout(accessOnly=false){
  if(rendered)return;if(checkoutLoading)return checkoutLoading;
  checkoutLoading=prepareCheckout(accessOnly).catch(e=>{status(e.message,true);retryButton(accessOnly?'Check access again':'Retry secure checkout',()=>initCheckout(accessOnly));}).finally(()=>{checkoutLoading=undefined;});return checkoutLoading;
}

import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
const ORDER='5O190127TN364715T',CAPTURE='8MC585209K746392H';
const originals=new Map(['window','document','localStorage','navigator','location','history','fetch','setInterval','clearInterval'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
const originalNow=Date.now;
let sequence=0;
afterEach(()=>{Date.now=originalNow;for(const [name,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
async function setup({existing=false,pending=false,consent=false,badConfig=false,badUrl=false,failedSdk=false,price='29.99',acceptedPrice=null}={}){
  const map=new Map(),storage=new Map(),state={calls:[],events:[],renders:0,paypalOptions:null,capturePending:pending,scriptFailures:0,price,acceptedPrice,windowListeners:new Map(),documentListeners:new Map()};
  class Element{
    constructor(){this.children=[];this.classList={toggle(){}};this.checked=true;this.textContent='';}
    append(...children){this.children.push(...children);for(const child of children)if(child.id)map.set('#'+child.id,child);}
    appendChild(child){this.append(child);if(child.src?.includes('paypal.com/sdk')){state.scriptFailures++;queueMicrotask(()=>child.onerror());}return child;}
    replaceChildren(...children){this.children=[];this.append(...children);}
    remove(){if(this.id)map.delete('#'+this.id);}
    addEventListener(){}removeEventListener(){}
  }
  for(const id of ['checkout-content','checkout-status','purchase-terms','paypal-buttons']){const el=new Element();el.id=id;map.set('#'+id,el);}
  const paypal={Buttons(options){state.paypalOptions=options;return{async render(){state.renders++;options.onInit({}, {enable(){},disable(){}});},async close(){}};}};
  const win={addEventListener:(name,fn)=>state.windowListeners.set(name,fn),removeEventListener:name=>state.windowListeners.delete(name),fbq:(...args)=>state.events.push(args),...(failedSdk?{}:{paypal})};
  const offerNodes={price:new Element(),promo:new Element(),countdown:new Element(),label:new Element()};
  const doc={addEventListener:(name,fn)=>state.documentListeners.set(name,fn),removeEventListener:name=>state.documentListeners.delete(name),cookie:'_fbp=fb.1.1726473600000.12345',head:new Element(),createElement:()=>new Element(),querySelector:sel=>map.get(sel)||null,querySelectorAll:sel=>({'[data-course-price]':[offerNodes.price],'[data-promo-only]':[offerNodes.promo],'[data-promo-countdown]':[offerNodes.countdown],'[data-promo-label]':[offerNodes.label]})[sel]||[]};
  const ls={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)};
  if(consent)ls.setItem('formumax-advertising-consent','yes');
  if(pending)ls.setItem('formumax-pending-checkout',JSON.stringify({orderId:ORDER,approvedAt:Date.now()}));
  const paid={orderId:ORDER,captureId:CAPTURE,notionUrl:badUrl?'https://notion.site.attacker.example/phish':'https://course.notion.site/global',eventId:'purchase_'+CAPTURE,price:acceptedPrice||price,currency:'USD'};
  const fetchMock=async(url,options)=>{
    state.calls.push({url,body:options.body?JSON.parse(options.body):undefined});
    if(url==='/api/config'&&state.configFailure)throw new TypeError('Mock disconnected network');
    if(url==='/api/config')return Response.json({productId:'ultimate-video-ai-mastery',price:badConfig?'1.00':state.price,regularPrice:'49.99',offerPrice:'29.99',offerActive:state.price==='29.99',offerExpiresAt:state.offerExpiresAt||new Date(Date.now()+(state.price==='29.99'?18000000:-1000)).toISOString(),serverTime:new Date(Date.now()).toISOString(),acceptedOrder:state.acceptedPrice?{orderId:ORDER,price:state.acceptedPrice,currency:'USD'}:null,currency:'USD',checkoutAvailable:true,paypalClientId:'mock-client',pixelId:'1467482891263700'});
    if(url==='/api/access')return existing?Response.json(paid):Response.json({error:{code:'ACCESS_REQUIRED',message:'Complete checkout.'}},{status:401});
    if(url==='/api/orders')return Response.json({orderId:ORDER,price:state.acceptedPrice||state.price,currency:'USD'});
    if(url==='/api/capture')return state.capturePending?Response.json({error:{code:'PAYMENT_PENDING',message:'Your payment is still processing.'}},{status:409}):Response.json(paid);
    throw Error('Unexpected local mock request');
  };
  for(const [name,value]of Object.entries({window:win,document:doc,localStorage:ls,navigator:{globalPrivacyControl:false},location:{hostname:'formumaxlabs.vercel.app',pathname:'/ultimatevideoaimastery'},history:{replaceState(){}},fetch:fetchMock,setInterval:callback=>{state.offerTick=callback;return{unref(){}};},clearInterval:()=>{}}))Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  const mod=await import(`../src/purchase.js?test=${++sequence}`);
  return{mod,state,map,storage,paypal,win,offerNodes};
}
test('concurrent checkout opens and order callbacks render/create only once',async()=>{
  const{mod,state}=await setup();await Promise.all([mod.initCheckout(),mod.initCheckout(),mod.initCheckout()]);assert.equal(state.renders,1);
  const ids=await Promise.all([state.paypalOptions.createOrder(),state.paypalOptions.createOrder()]);assert.deepEqual(ids,[ORDER,ORDER]);assert.equal(state.calls.filter(c=>c.url==='/api/orders').length,1);assert.equal(state.calls.find(c=>c.url==='/api/orders').body.expectedPrice,'29.99');
});
test('frontend rejects mismatched server price before loading a checkout',async()=>{
  const{mod,state,map}=await setup({badConfig:true});await mod.initCheckout();assert.equal(state.renders,0);assert.match(map.get('#checkout-status').textContent,/checkout details have changed/);assert.equal(state.calls.length,1);
});
test('existing paid access avoids a duplicate order and does not replay Purchase',async()=>{
  const{mod,state,map}=await setup({existing:true,consent:true});await mod.initCheckout();assert.equal(state.renders,0);assert.equal(state.calls.some(c=>c.url==='/api/orders'),false);assert.equal(state.events.some(e=>e[1]==='Purchase'),false);assert.ok(map.get('#checkout-content').children.some(c=>c.href==='https://course.notion.site/global'));
});
test('pending approved payment recovers after reload using the same reference',async()=>{
  const{mod,state,map}=await setup({pending:true});await mod.initCheckout(true);assert.equal(state.renders,0);assert.match(map.get('#checkout-status').textContent,/still processing/);assert.equal(state.calls.filter(c=>c.url==='/api/capture')[0].body.orderId,ORDER);state.capturePending=false;await map.get('#checkout-retry').onclick();assert.ok(map.get('#checkout-content').children.some(c=>c.href==='https://course.notion.site/global'));assert.equal(state.calls.some(c=>c.url==='/api/orders'),false);
});
test('first advertising consent queues PageView and ViewContent; revoked consent blocks Purchase',async()=>{
  const{mod,state}=await setup({consent:true});await mod.initTracking();assert.ok(state.events.some(e=>e[0]==='track'&&e[1]==='PageView'));assert.ok(state.events.some(e=>e[0]==='track'&&e[1]==='ViewContent'));assert.equal(state.events.find(e=>e[1]==='ViewContent')[2].value,29.99);await mod.initCheckout();await state.paypalOptions.createOrder();mod.setConsent(false);await state.paypalOptions.onApprove({orderID:ORDER},{});assert.equal(state.calls.find(c=>c.url==='/api/capture').body.consent,false);assert.equal(state.events.some(e=>e[1]==='Purchase'),false);
});
test('catalog, access, and legal pages do not report a course product view',async()=>{
  for(const path of ['/','/ultimatevideoaimastery/access','/privacy']){
    const{mod,state}=await setup({consent:true});location.pathname=path;await mod.initTracking();
    assert.ok(state.events.some(e=>e[0]==='track'&&e[1]==='PageView'));
    assert.equal(state.events.some(e=>e[0]==='track'&&e[1]==='ViewContent'),false,path);
  }
});
test('capture retries retain backend Purchase event ID and do not double-track',async()=>{
  const{mod,state}=await setup({consent:true});await mod.initCheckout();await state.paypalOptions.createOrder();await Promise.all([state.paypalOptions.onApprove({orderID:ORDER},{}),state.paypalOptions.onApprove({orderID:ORDER},{})]);const purchases=state.events.filter(e=>e[1]==='Purchase');assert.equal(purchases.length,1);assert.equal(purchases[0][3].eventID,'purchase_'+CAPTURE);assert.equal(purchases[0][2].value,29.99);assert.equal(state.calls.filter(c=>c.url==='/api/capture').length,1);
});
test('PayPal SDK loading errors offer a usable retry',async()=>{
  const{mod,state,map,win,paypal}=await setup({failedSdk:true});await mod.initCheckout();assert.match(map.get('#checkout-status').textContent,/PayPal could not load/);assert.equal(state.renders,0);win.paypal=paypal;await map.get('#checkout-retry').onclick();assert.equal(state.renders,1);
});
test('untrusted Notion-like access URLs cannot become clickable fulfillment links',async()=>{
  const{mod,map}=await setup({existing:true,badUrl:true});await mod.initCheckout(true);assert.match(map.get('#checkout-status').textContent,/course link could not be verified/);assert.equal(map.get('#checkout-content').children.some(c=>c.href),false);
});

test('offer, tracking and checkout share first-visit config without duplicate cookie requests',async()=>{
  const{mod,state}=await setup({consent:true});const result=await Promise.all([mod.initOffer(),mod.initTracking(),mod.initCheckout()]);
  assert.equal(state.calls.filter(call=>call.url==='/api/config').length,1);result[0]();
});
test('countdown reaches zero, hides promotion, displays USD49.99 and rechecks the server',async()=>{
  const now=originalNow();Date.now=()=>now;const{mod,state,offerNodes}=await setup();state.offerExpiresAt=new Date(now+1000).toISOString();
  const cleanup=await mod.initOffer();assert.equal(offerNodes.price.textContent,'$29.99');assert.equal(offerNodes.countdown.textContent,'00:00:01');
  Date.now=()=>now+1100;state.price='49.99';state.offerTick();await Promise.resolve();await Promise.resolve();
  assert.equal(offerNodes.price.textContent,'$49.99');assert.equal(offerNodes.countdown.textContent,'00:00:00');assert.equal(offerNodes.promo.hidden,true);
  assert.equal(state.calls.filter(call=>call.url==='/api/config').length,2);cleanup();
});
test('price expiry during checkout requires review before any order is created',async()=>{
  const{mod,state,map}=await setup();await mod.initCheckout();state.price='49.99';
  await assert.rejects(state.paypalOptions.createOrder(),error=>error.code==='PRICE_CHANGED');
  assert.equal(state.calls.some(call=>call.url==='/api/orders'),false);assert.equal(map.get('#purchase-terms').checked,false);
  map.get('#purchase-terms').checked=true;state.paypalOptions.onClick({},{});await state.paypalOptions.createOrder();
  assert.equal(state.calls.find(call=>call.url==='/api/orders').body.expectedPrice,'49.99');
});
test('current promotional and regular prices preserve cents in labels, order requests, receipts and Purchase',async()=>{
  for(const price of ['29.99','49.99']){
    const{mod,state,map,offerNodes}=await setup({consent:true,price});
    await mod.initCheckout();assert.equal(offerNodes.price.textContent,`$${price}`);
    await state.paypalOptions.createOrder();
    assert.equal(state.calls.find(call=>call.url==='/api/orders').body.expectedPrice,price);
    await state.paypalOptions.onApprove({orderID:ORDER},{});
    assert.equal(state.events.find(event=>event[1]==='Purchase')[2].value,Number(price));
    assert.ok(map.get('#checkout-content').children.some(node=>node.textContent?.startsWith(`Paid US$${price} ·`)));
  }
});
test('an existing discounted order stays USD29.99 while public course labels show USD49.99',async()=>{
  const{mod,state,offerNodes}=await setup({price:'49.99',acceptedPrice:'29.99'});await mod.initCheckout();await state.paypalOptions.createOrder();
  assert.equal(offerNodes.price.textContent,'$49.99');assert.equal(state.calls.find(call=>call.url==='/api/orders').body.expectedPrice,'29.99');
});

test('initial price lookup failure clears stale promotional amounts and retries when the page regains focus',async()=>{
  const{mod,state,offerNodes}=await setup({price:'49.99'});offerNodes.price.textContent='$29.99';state.configFailure=true;
  const cleanup=await mod.initOffer();
  assert.equal(offerNodes.price.textContent,'Check price');assert.equal(offerNodes.promo.hidden,true);
  await mod.initCheckout();assert.equal(state.renders,0);assert.equal(state.calls.some(call=>call.url==='/api/orders'),false);
  state.configFailure=false;await state.windowListeners.get('focus')();
  assert.equal(offerNodes.price.textContent,'$49.99');assert.equal(offerNodes.promo.hidden,true);
  cleanup();assert.equal(state.windowListeners.has('focus'),false);assert.equal(state.documentListeners.has('visibilitychange'),false);
});


test('historical USD19, USD29 and USD99 amounts cannot be advertised as current checkout prices',async()=>{
  for(const price of ['19.00','29.00','99.00']){
    const{mod,state,map}=await setup({price});await mod.initCheckout();
    assert.equal(state.renders,0);assert.equal(state.calls.some(call=>call.url==='/api/orders'),false);
    assert.match(map.get('#checkout-status').textContent,/checkout price could not be verified/);
  }
});
test('a server-accepted historical USD99 order keeps its amount through capture and Meta Purchase',async()=>{
  const{mod,state,map,offerNodes}=await setup({consent:true,price:'29.99',acceptedPrice:'99.00'});
  await mod.initCheckout();await state.paypalOptions.createOrder();await state.paypalOptions.onApprove({orderID:ORDER},{});
  assert.equal(offerNodes.price.textContent,'$29.99');
  assert.equal(state.calls.find(call=>call.url==='/api/orders').body.expectedPrice,'99.00');
  const purchases=state.events.filter(event=>event[1]==='Purchase');
  assert.equal(purchases.length,1);assert.equal(purchases[0][2].value,99);
  assert.equal(purchases[0][3].eventID,'purchase_'+CAPTURE);
  assert.ok(map.get('#checkout-content').children.some(node=>node.textContent?.includes('Paid US$99')));
  assert.ok(map.get('#checkout-content').children.some(node=>node.href==='https://course.notion.site/global'));
});
test('verified historical USD99 access displays the original receipt without a new order or replayed Purchase',async()=>{
  const{mod,state,map}=await setup({existing:true,consent:true,price:'49.99',acceptedPrice:'99.00'});
  await mod.initCheckout(true);
  assert.equal(state.renders,0);assert.equal(state.calls.some(call=>call.url==='/api/orders'),false);
  assert.equal(state.events.some(event=>event[1]==='Purchase'),false);
  assert.ok(map.get('#checkout-content').children.some(node=>node.textContent?.includes('Paid US$99')));
  assert.ok(map.get('#checkout-content').children.some(node=>node.href==='https://course.notion.site/global'));
});


test('server-accepted historical USD19 and USD29 orders preserve their amounts after the price migration',async()=>{
  for(const acceptedPrice of ['19.00','29.00']){
    const{mod,state,map,offerNodes}=await setup({consent:true,price:'49.99',acceptedPrice});
    await mod.initCheckout();assert.equal(offerNodes.price.textContent,'$49.99');
    await state.paypalOptions.createOrder();
    assert.equal(state.calls.find(call=>call.url==='/api/orders').body.expectedPrice,acceptedPrice);
    await state.paypalOptions.onApprove({orderID:ORDER},{});
    assert.equal(state.events.find(event=>event[1]==='Purchase')[2].value,Number(acceptedPrice));
    assert.ok(map.get('#checkout-content').children.some(node=>node.textContent?.startsWith(`Paid US$${Number(acceptedPrice)} ·`)));
  }
});
test('verified historical USD19 and USD29 access is restored without another order or replayed Purchase',async()=>{
  for(const acceptedPrice of ['19.00','29.00']){
    const{mod,state,map}=await setup({existing:true,consent:true,acceptedPrice});
    await mod.initCheckout(true);
    assert.equal(state.renders,0);assert.equal(state.calls.some(call=>call.url==='/api/orders'),false);
    assert.equal(state.events.some(event=>event[1]==='Purchase'),false);
    assert.ok(map.get('#checkout-content').children.some(node=>node.textContent?.startsWith(`Paid US$${Number(acceptedPrice)} ·`)));
    assert.ok(map.get('#checkout-content').children.some(node=>node.href==='https://course.notion.site/global'));
  }
});

import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
const ORDER='5O190127TN364715T',CAPTURE='8MC585209K746392H';
const originals=new Map(['window','document','localStorage','navigator','location','history','fetch'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
let sequence=0;
afterEach(()=>{for(const [name,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
async function setup({existing=false,pending=false,consent=false,badConfig=false,badUrl=false,failedSdk=false}={}){
  const map=new Map(),storage=new Map(),state={calls:[],events:[],renders:0,paypalOptions:null,capturePending:pending,scriptFailures:0};
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
  const win={addEventListener(){},fbq:(...args)=>state.events.push(args),...(failedSdk?{}:{paypal})};
  const doc={cookie:'_fbp=fb.1.1726473600000.12345',head:new Element(),createElement:()=>new Element(),querySelector:sel=>map.get(sel)||null};
  const ls={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)};
  if(consent)ls.setItem('formumax-advertising-consent','yes');
  if(pending)ls.setItem('formumax-pending-checkout',JSON.stringify({orderId:ORDER,approvedAt:Date.now()}));
  const paid={orderId:ORDER,captureId:CAPTURE,notionUrl:badUrl?'https://notion.site.attacker.example/phish':'https://course.notion.site/global',eventId:'purchase_'+CAPTURE,price:'29.00',currency:'USD'};
  const fetchMock=async(url,options)=>{
    state.calls.push({url,body:options.body?JSON.parse(options.body):undefined});
    if(url==='/api/config')return Response.json({productId:'ultimate-video-ai-mastery',price:badConfig?'1.00':'29.00',currency:'USD',checkoutAvailable:true,paypalClientId:'mock-client',pixelId:'1467482891263700'});
    if(url==='/api/access')return existing?Response.json(paid):Response.json({error:{code:'ACCESS_REQUIRED',message:'Complete checkout.'}},{status:401});
    if(url==='/api/orders')return Response.json({orderId:ORDER,price:'29.00',currency:'USD'});
    if(url==='/api/capture')return state.capturePending?Response.json({error:{code:'PAYMENT_PENDING',message:'Your payment is still processing.'}},{status:409}):Response.json(paid);
    throw Error('Unexpected local mock request');
  };
  for(const [name,value]of Object.entries({window:win,document:doc,localStorage:ls,navigator:{globalPrivacyControl:false},location:{hostname:'formumaxlabs.vercel.app',pathname:'/ultimatevideoaimastery'},history:{replaceState(){}},fetch:fetchMock}))Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  const mod=await import(`../src/purchase.js?test=${++sequence}`);
  return{mod,state,map,storage,paypal,win};
}
test('concurrent checkout opens and order callbacks render/create only once',async()=>{
  const{mod,state}=await setup();await Promise.all([mod.initCheckout(),mod.initCheckout(),mod.initCheckout()]);assert.equal(state.renders,1);
  const ids=await Promise.all([state.paypalOptions.createOrder(),state.paypalOptions.createOrder()]);assert.deepEqual(ids,[ORDER,ORDER]);assert.equal(state.calls.filter(c=>c.url==='/api/orders').length,1);
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
  const{mod,state}=await setup({consent:true});await mod.initTracking();assert.ok(state.events.some(e=>e[0]==='track'&&e[1]==='PageView'));assert.ok(state.events.some(e=>e[0]==='track'&&e[1]==='ViewContent'));await mod.initCheckout();await state.paypalOptions.createOrder();mod.setConsent(false);await state.paypalOptions.onApprove({orderID:ORDER},{});assert.equal(state.calls.find(c=>c.url==='/api/capture').body.consent,false);assert.equal(state.events.some(e=>e[1]==='Purchase'),false);
});
test('catalog, access, and legal pages do not report a course product view',async()=>{
  for(const path of ['/','/ultimatevideoaimastery/access','/privacy']){
    const{mod,state}=await setup({consent:true});location.pathname=path;await mod.initTracking();
    assert.ok(state.events.some(e=>e[0]==='track'&&e[1]==='PageView'));
    assert.equal(state.events.some(e=>e[0]==='track'&&e[1]==='ViewContent'),false,path);
  }
});
test('capture retries retain backend Purchase event ID and do not double-track',async()=>{
  const{mod,state}=await setup({consent:true});await mod.initCheckout();await state.paypalOptions.createOrder();await Promise.all([state.paypalOptions.onApprove({orderID:ORDER},{}),state.paypalOptions.onApprove({orderID:ORDER},{})]);const purchases=state.events.filter(e=>e[1]==='Purchase');assert.equal(purchases.length,1);assert.equal(purchases[0][3].eventID,'purchase_'+CAPTURE);assert.equal(state.calls.filter(c=>c.url==='/api/capture').length,1);
});
test('PayPal SDK loading errors offer a usable retry',async()=>{
  const{mod,state,map,win,paypal}=await setup({failedSdk:true});await mod.initCheckout();assert.match(map.get('#checkout-status').textContent,/PayPal could not load/);assert.equal(state.renders,0);win.paypal=paypal;await map.get('#checkout-retry').onclick();assert.equal(state.renders,1);
});
test('untrusted Notion-like access URLs cannot become clickable fulfillment links',async()=>{
  const{mod,map}=await setup({existing:true,badUrl:true});await mod.initCheckout(true);assert.match(map.get('#checkout-status').textContent,/course link could not be verified/);assert.equal(map.get('#checkout-content').children.some(c=>c.href),false);
});

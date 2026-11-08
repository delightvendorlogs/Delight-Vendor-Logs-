import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const KIND = "DVL";
const GLOBAL_MARKUP_ID = "__GLOBAL_MARKUP__";
const URL = Deno.env.get("SUPABASE_URL") || "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BASE = "https://v2.api.logsplug.com/api/v2";
const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json"};
const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:cors});
const fail=(error:string,status=400,extra:Record<string,unknown>={})=>reply({error,...extra},status);
const db=createClient(URL,SERVICE,{auth:{persistSession:false}});
function apiKey(){const k=Deno.env.get("LOGSPLUG_API_KEY")||"";if(!k.trim())throw new Error("Additional service provider is not configured. Please contact support.");return k.trim();}
async function provider(path:string,method="GET",payload?:unknown){
 const response=await fetch(BASE+path,{method,headers:{"x-api-key":apiKey(),"Accept":"application/json","Content-Type":"application/json"},...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:AbortSignal.timeout(35000)});
 const raw=await response.text();let data:any=raw;try{data=JSON.parse(raw)}catch{}
 return {response,data,raw};
}
function logsArray(x:any):any[]{const a=x?.data?.logs??x?.logs??x?.data?.items??x?.items??x?.data??[];return Array.isArray(a)?a:[];}
function catsArray(x:any):any[]{const a=x?.data?.categories??x?.categories??x?.data??[];return Array.isArray(a)?a:[];}
function logId(x:any){return String(x?._id??x?.id??"");}
function normalize(x:any,cfg:any={}){
 const cat=x?.category??{},sub=x?.subCategory??{};
 const id=logId(x),categoryId=String(cat?._id??cat?.id??x?.logsType??"other"),displayName=String(x?.name??x?.title??x?.logsType??"Service");
 const categoryName=String(cat?.logsType??cat?.name??x?.logsType??"Other");
 const rawProviderPrice=x?.apiUnitPrice??x?.unitPrice??x?.listUnitPrice??0;
 const providerPrice=Number(rawProviderPrice);
 const markup=Number(cfg?.markup_percent??50);
 const custom=cfg?.custom_price===null||cfg?.custom_price===undefined?null:Number(cfg.custom_price);
 const customerPrice=custom!==null?custom:Math.round(providerPrice*(1+markup/100)*100)/100;
 return {id,name:displayName,title:displayName,description:String(x?.description??""),usage:String(x?.usage??""),logo:String(x?.logo??""),category_id:categoryId,category_name:categoryName,subcategory_name:String(sub?.logsType??sub?.name??x?.logsSubType??""),available_stock:Number(x?.availableStock??0),total_stock:Number(x?.totalStock??0),provider_price:providerPrice,customer_price:customerPrice,markup_percent:markup,custom_price:custom,is_active:cfg?.enabled!==false,is_available:x?.isAvailable!==false&&Number(x?.availableStock??0)>0,raw:x};
}
async function catalog(page=1,limit=100,category="",search="",includeDisabled=false){
 const qs=new URLSearchParams({page:String(page),limit:String(Math.min(100,Math.max(1,limit)))});
 if(category)qs.set("category",category);if(search)qs.set("search",search);
 const [cr,lr]=await Promise.all([provider("/third-party/logs/categories"),provider("/third-party/logs?"+qs.toString())]);
 if(!cr.response.ok)throw new Error("Could not load the additional service categories.");
 if(!lr.response.ok)throw new Error("Could not load the additional services.");
 const categories=catsArray(cr.data),logs=logsArray(lr.data);
 const ids=logs.map(logId).filter(Boolean);
 const [saved,globalQ]=await Promise.all([
   ids.length?db.from("logsplug_pricing").select("*").in("log_id",ids):Promise.resolve({data:[],error:null}),
   db.from("logsplug_pricing").select("markup_percent").eq("log_id",GLOBAL_MARKUP_ID).maybeSingle()
 ]);
 if(saved.error)throw saved.error;
 if(globalQ.error)throw globalQ.error;
 const globalMarkup=Number(globalQ.data?.markup_percent??50);
 const cfg=new Map((saved.data||[]).map((x:any)=>[String(x.log_id),x]));
 return {categories,globalMarkup,logs:logs.map((x:any)=>normalize(x,cfg.get(logId(x))||{markup_percent:globalMarkup})).filter((x:any)=>x.id&&(includeDisabled||x.is_active)),page,limit,providerMeta:lr.data?.data?.pagination??lr.data?.pagination??null};
}
async function isAdmin(user:any){
 if(KIND==="DVL"){const q=await db.from("admin_users").select("user_id").eq("user_id",user.id).maybeSingle();if(q.error)throw q.error;return !!q.data;}
 const q=await createClient(URL,ANON,{global:{headers:{Authorization:"Bearer "+user.access_token}},auth:{persistSession:false}}).rpc("is_admin");
 return !q.error&&q.data===true;
}
async function main(req:Request){
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return fail("POST required.",405);
 if(!URL||!ANON||!SERVICE)return fail("Supabase function secrets are incomplete.",500);
 const auth=req.headers.get("Authorization")||"";
 const token=auth.replace(/^Bearer\s+/i,"");
 if(!token)return fail("Please sign in to continue.",401);
 const userClient=createClient(URL,ANON,{global:{headers:{Authorization:"Bearer "+token}},auth:{persistSession:false}});
 const who=await userClient.auth.getUser(token);
 if(who.error||!who.data.user)return fail("Your session expired. Please sign in again.",401);
 const user=who.data.user;
 const body=await req.json().catch(()=>({}));
 const action=String(body.action||"");
 if(action==="catalog"){
   const c=await catalog(Number(body.page)||1,Number(body.limit)||100,String(body.category||""),String(body.search||""));
   return reply({categories:c.categories.map((x:any)=>({id:String(x._id??x.id??x.logsType??""),name:String(x.logsType??x.name??"Category"),logo:x.logo??null})),logs:c.logs.map((x:any)=>({id:x.id,name:x.name,title:x.name,description:x.description,usage:x.usage,logo:x.logo,category_id:x.category_id,category_name:x.category_name,subcategory_name:x.subcategory_name,available_stock:x.available_stock,customer_price:x.customer_price,is_available:x.is_available})),page:c.page,limit:c.limit,pagination:c.providerMeta});
 }
 if(action==="admin_catalog"){
   if(!(await isAdmin(user)))return fail("Admin access required.",403);
   const c=await catalog(Number(body.page)||1,Number(body.limit)||100,String(body.category||""),String(body.search||""),true);
   const w=await provider("/third-party/wallet/balance");
   if(!w.response.ok)throw new Error("Could not load LogsPlug provider wallet balance.");
   return reply({categories:c.categories,global_markup_percent:c.globalMarkup,logs:c.logs.map((x:any)=>({id:x.id,name:x.name,title:x.name,category_id:x.category_id,category_name:x.category_name,available_stock:x.available_stock,total_stock:x.total_stock,provider_price:x.provider_price,customer_price:x.customer_price,markup_percent:x.markup_percent,custom_price:x.custom_price,is_active:x.is_active,is_available:x.is_available})),provider_wallet:w.data?.data??w.data,pagination:c.providerMeta});
 }
 if(action==="save_global_markup"){
   if(!(await isAdmin(user,token)))return fail("Admin access required.",403);
   const markup=Number(body.markup_percent);
   if(!Number.isFinite(markup)||markup<0||markup>10000)return fail("Enter a valid markup percentage from 0 to 10000.");
   const now=new Date().toISOString();
   const saved=await db.from("logsplug_pricing").upsert({log_id:GLOBAL_MARKUP_ID,title:"Global markup rule",category_id:"__GLOBAL__",category_name:"Global",markup_percent:markup,custom_price:null,enabled:true,updated_at:now},{onConflict:"log_id"}).select("log_id,markup_percent").single();
   if(saved.error)throw saved.error;
   const verify=await db.from("logsplug_pricing").select("markup_percent").eq("log_id",GLOBAL_MARKUP_ID).single();
   if(verify.error)throw verify.error;
   if(Number(verify.data.markup_percent)!==markup)throw new Error("Global markup could not be verified as saved.");
   const updated=await db.from("logsplug_pricing").update({markup_percent:markup,updated_at:now}).neq("log_id",GLOBAL_MARKUP_ID);
   if(updated.error)throw updated.error;
   return reply({ok:true,markup_percent:markup,saved:true});
 }
 if(action==="save_pricing"){
   if(!(await isAdmin(user)))return fail("Admin access required.",403);
   if(!Array.isArray(body.items))return fail("Pricing items are required.");
   const rows=[];
   for(const item of body.items){
     const id=String(item?.log_id??"").trim(),title=String(item?.name??item?.title??"").trim();
     const markup=Number(item?.markup_percent??50),custom=item?.custom_price===""||item?.custom_price==null?null:Number(item.custom_price);
     if(!id||id===GLOBAL_MARKUP_ID||!title||!Number.isFinite(markup)||markup<0||markup>10000||(custom!==null&&(!Number.isFinite(custom)||custom<0)))return fail("A pricing row contains invalid values.");
     rows.push({log_id:id,title,category_id:String(item.category_id??""),category_name:String(item.category_name??""),markup_percent:markup,custom_price:custom,enabled:item.enabled!==false,updated_at:new Date().toISOString()});
   }
   if(rows.length){
     const saved=await db.from("logsplug_pricing").upsert(rows,{onConflict:"log_id"}).select("log_id");
     if(saved.error)throw saved.error;
     const savedIds=new Set((saved.data||[]).map((x:any)=>String(x.log_id)));
     if(rows.some((x:any)=>!savedIds.has(String(x.log_id))))throw new Error("Some service pricing settings could not be verified as saved.");
   }
   return reply({ok:true,saved_count:rows.length});
 }
 if(action==="admin_orders"){
   if(!(await isAdmin(user,token)))return fail("Admin access required.",403);
   const q=await db.from("logsplug_orders").select("id,user_id,log_id,provider_order_id,title_snapshot,category_name,quantity,customer_total,status,created_at").order("created_at",{ascending:false}).limit(100);
   if(q.error)throw q.error;
   return reply({orders:q.data||[]});
 }
 if(action==="purchase"){
   const id=String(body.logId??"").trim(),quantity=Number(body.quantity??1);
   const selectionType=String(body.selectionType??"DEFAULT").toUpperCase();
   const indices=Array.isArray(body.selectedIndices)?body.selectedIndices:[];
   if(!id||!Number.isInteger(quantity)||quantity<1||quantity>50||!["DEFAULT","MANUAL"].includes(selectionType))return fail("Choose a valid log and quantity (1–50).");
   if(selectionType==="MANUAL"&&(indices.length!==quantity||new Set(indices).size!==indices.length||indices.some((x:any)=>!Number.isInteger(x)||x<0)))return fail("Select exactly one unique stock index for each log.");
   const found=await provider("/third-party/logs?"+new URLSearchParams({page:"1",limit:"100",search:id}).toString());
   if(!found.response.ok)return fail("Additional services are temporarily unavailable.",502);
   let item=logsArray(found.data).find((x:any)=>logId(x)===id);
   if(!item){
     for(let page=1;page<=10&&!item;page++){
       const p=await provider("/third-party/logs?"+new URLSearchParams({page:String(page),limit:"100"}).toString());
       if(!p.response.ok)break;item=logsArray(p.data).find((x:any)=>logId(x)===id);
       if(logsArray(p.data).length<100)break;
     }
   }
   if(!item)return fail("This log is no longer available. Refresh the catalogue.",404);
   const [cfgq,globalQ]=await Promise.all([db.from("logsplug_pricing").select("*").eq("log_id",id).maybeSingle(),db.from("logsplug_pricing").select("markup_percent").eq("log_id",GLOBAL_MARKUP_ID).maybeSingle()]);
   if(cfgq.error)throw cfgq.error;if(globalQ.error)throw globalQ.error;
   const log=normalize(item,cfgq.data||{markup_percent:Number(globalQ.data?.markup_percent??50)});
   if(cfgq.data?.enabled===false||!log.is_available||log.available_stock<quantity)return fail("Not enough stock is available for this quantity.",409);
   const total=Math.round(log.customer_price*quantity*100)/100;
   if(!Number.isFinite(total)||total<=0)return fail("This log has an invalid selling price. Contact support.",503);
   const reference="LOGSPLUG-"+crypto.randomUUID();
   let debit:any=null,transactionId:string|null=null;
   if(KIND==="DVL"){
     const d=await userClient.rpc("social_log_debit",{p_user_id:user.id,p_amount:total,p_reference:reference,p_description:"Logs order: "+log.title+" (1)"});if(d.error)throw d.error;debit=d.data;
     if(!debit?.ok)return fail("Insufficient fund. Please fund wallet.",402,{code:"CUSTOMER_INSUFFICIENT_FUNDS",balance:Number(debit?.balance??0),shortfall:Number(debit?.shortfall??total)});
   }else{
     const d=await db.rpc("debit_product_wallet",{p_user_id:user.id,p_amount:total,p_reference:reference,p_description:"Additional service purchase — "+log.title+" (1)"});if(d.error)throw d.error;debit=d.data;
     if(!debit?.ok)return fail(debit?.reason==="insufficient_balance"?"Insufficient fund. Please fund wallet.":"Your wallet is not ready. Please contact support.",402,{balance:debit?.balance});
     transactionId=String(debit.transaction_id||"");
   }
   const initial=await db.from("logsplug_orders").insert({user_id:user.id,log_id:id,title_snapshot:log.title+" (1)",category_id:log.category_id,category_name:log.category_name,quantity,provider_unit_price:log.provider_price,customer_unit_price:log.customer_price,customer_total:total,status:"processing",selection_type:selectionType,selected_indices:selectionType==="MANUAL"?indices:null,wallet_reference:reference,wallet_transaction_id:transactionId}).select("id").single();
   if(initial.error){
     if(KIND==="DVL")await db.rpc("social_log_refund",{p_user_id:user.id,p_amount:total,p_reference:reference+"-refund",p_description:"Refund for unsaved LogsPlug order"});
     else if(transactionId)await db.rpc("finish_product_wallet_purchase",{p_transaction_id:transactionId,p_success:false,p_note:"LogsPlug order record could not be created; refund"});
     return fail("We could not create your order record. Your wallet refund has been requested.",500);
   }
   let placed:any;
   try{
     placed=await provider("/third-party/logs/order","POST",{logId:id,quantity,selectionType,selectedIndices:selectionType==="MANUAL"?indices:[]});
   }catch(e){
     await db.from("logsplug_orders").update({status:"review_required",updated_at:new Date().toISOString()}).eq("id",initial.data.id);
     return reply({ok:false,reviewRequired:true,message:"The provider connection was interrupted after payment. Do not place this order again yet; support must verify the provider order first.",reference},202);
   }
   const logicalFailure=placed.data?.success===false||placed.data?.status===false||(placed.data?.error!==undefined&&placed.data?.error!==null&&placed.data?.error!=="");
   if(!placed.response.ok||logicalFailure){
     const msg=String(placed.data?.message??placed.data?.error?.message??placed.data?.error??placed.raw??"").slice(0,500);
     const providerFailureDetails=msg+" "+String(placed.raw||"")+" "+JSON.stringify(placed.data??{});
     const providerInsufficient=/insufficient.{0,40}(fund|balance)|(?:fund|balance).{0,40}insufficient|not enough balance|low balance|wallet balance.{0,30}(low|empty)|out of credits?/i.test(providerFailureDetails);
     if(providerInsufficient){
       let rollback:any;
       if(KIND==="DVL"){
         rollback=await userClient.rpc("social_log_discard_failed_purchase",{p_user_id:user.id,p_reference:reference});
       }else if(transactionId){
         rollback=await db.rpc("discard_failed_product_wallet_purchase",{p_transaction_id:transactionId});
       }
       if(rollback?.error||!rollback?.data?.ok){
         rollback=KIND==="DVL"
           ? await userClient.rpc("social_log_discard_failed_purchase",{p_user_id:user.id,p_reference:reference})
           : transactionId ? await db.rpc("discard_failed_product_wallet_purchase",{p_transaction_id:transactionId}) : rollback;
       }
       if(rollback?.error||!rollback?.data?.ok) console.error("Provider-insufficient wallet rollback needs support review.",rollback?.error?.message||rollback?.data);
       await db.from("logsplug_orders").delete().eq("id",initial.data.id).eq("user_id",user.id);
       return fail("Insufficient fund. Please contact support.",502,{code:"PROVIDER_INSUFFICIENT_FUNDS",walletRestored:!rollback?.error&&!!rollback?.data?.ok});
     }
     if(placed.response.status<500){
       if(KIND==="DVL")await db.rpc("social_log_refund",{p_user_id:user.id,p_amount:total,p_reference:reference+"-refund",p_description:"LogsPlug order rejected; refund for "+log.title});
       else if(transactionId)await db.rpc("finish_product_wallet_purchase",{p_transaction_id:transactionId,p_success:false,p_note:"Additional provider rejected purchase: "+msg});
       await db.from("logsplug_orders").update({status:"failed_refunded",provider_response:placed.data}).eq("id",initial.data.id);
       return providerInsufficient
         ? fail("Insufficient fund. Please contact support.",502,{code:"PROVIDER_INSUFFICIENT_FUNDS",refunded:true})
         : fail("We could not complete this order. Your wallet refund has been requested.",502,{refunded:true});
     }
     await db.from("logsplug_orders").update({status:"review_required",provider_response:placed.data,updated_at:new Date().toISOString()}).eq("id",initial.data.id);
     return reply({ok:false,reviewRequired:true,message:"LogsPlug returned an uncertain response. Your order is held for verification; please contact support before retrying.",reference},202);
   }
   const payload=placed.data?.data??placed.data;
   const orderId=String(payload?.order?.id??payload?.orderId??payload?.id??"");
   const state=String(payload?.status??payload?.order?.status??"pending").toLowerCase();
   const status=["completed","success","successful","done"].includes(state)?"completed":"pending";
   const credentials=payload?.credentials??payload?.log?.credentials??payload?.order?.credentials??payload?.data?.credentials??null;
   await db.from("logsplug_orders").update({provider_order_id:orderId||null,status,credentials,provider_response:placed.data,updated_at:new Date().toISOString()}).eq("id",initial.data.id);
   if(KIND==="DVL"){
     const hist=await db.from("social_log_orders").insert({user_id:user.id,provider_order_id:orderId||null,service_id:id,service_name:log.title+" (1)",category_id:log.category_id,customer_price:total,provider_price:log.provider_price*quantity,quantity,status,order_data:{selectionType,selectedIndices:indices},provider_response:placed.data,updated_at:new Date().toISOString()});
     if(hist.error)console.error("Could not mirror LogsPlug order into existing customer history",hist.error.message);
   }else{
     const now=new Date().toISOString();
     const order=await db.from("orders").insert({customer_user_id:user.id,order_status:status==="pending"?"processing":"completed",payment_status:"verified",subtotal:total,fees:0,total,currency:"NGN",payment_provider:"wallet",payment_reference:reference,paid_at:now,completed_at:status==="completed"?now:null}).select("id,order_number").single();
     if(order.error)console.error("LogsPlug order header insert failed",order.error.message);
     else{
       const itemInsert=await db.from("order_items").insert({order_id:order.data.id,item_source:"logsplug_log",provider_section:log.category_name+" (1)",provider_item_reference:id,item_title_snapshot:log.title+" (1)",quantity,unit_price:log.customer_price,platform_commission:0,seller_net_amount:0,fulfillment_status:status==="pending"?"processing":"completed",delivery_payload:placed.data}).select("id").single();
       if(itemInsert.error)console.error("LogsPlug order item insert failed",itemInsert.error.message);
       else{const profit=await db.rpc("queue_referral_profit_for_order_item",{p_order_item_id:itemInsert.data.id,p_provider_cost:log.provider_price*quantity,p_customer_price:total});if(profit.error)console.error("LogsPlug referral profit recording failed",profit.error.message);}
       if(transactionId)await db.from("wallet_transactions").update({related_order_id:order.data.id,description:"Additional service purchase — "+log.title+" (1)",metadata:{source:"logsplug",category:log.category_name,log_id:id,provider_order_id:orderId,credentials}}).eq("id",transactionId);
     }
     if(transactionId)await db.rpc("finish_product_wallet_purchase",{p_transaction_id:transactionId,p_success:true,p_note:"Additional service purchase completed — "+log.title+" (1)"});
   }
   return reply({ok:true,message:status==="completed"?"Purchase completed successfully.":"Purchase submitted and is pending provider processing.",status,reference,providerOrderId:orderId,credentials:credentials??payload,providerResponse:placed.data,balance:debit?.balance??null});
 }
 return fail("Unknown action.");
}
Deno.serve(async(req:Request)=>{try{return await main(req)}catch(e){const msg=e instanceof Error?e.message:"Unexpected error";console.error("LogsPlug function error:",msg);return fail("The service is temporarily unavailable. Please try again or contact support.",503)}});

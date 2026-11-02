(function(){'use strict';
var busy=false, last='';
function copyAttrs(from,to){Array.from(to.attributes).forEach(function(a){if(!from.hasAttribute(a.name))to.removeAttribute(a.name)});Array.from(from.attributes).forEach(function(a){if(to.getAttribute(a.name)!==a.value)to.setAttribute(a.name,a.value)})}
function sync(oldNode,newNode){
 if(!oldNode||!newNode||oldNode.nodeType!==newNode.nodeType||oldNode.nodeName!==newNode.nodeName)return;
 if(oldNode.nodeType===3){if(oldNode.nodeValue!==newNode.nodeValue)oldNode.nodeValue=newNode.nodeValue;return}
 if(oldNode.nodeType!==1)return;
 var tag=oldNode.tagName;
 if(tag==='SCRIPT')return;
 if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'){copyAttrs(newNode,oldNode);return}
 if(tag==='STYLE'){if(oldNode.textContent!==newNode.textContent)oldNode.textContent=newNode.textContent;return}
 if(tag==='LINK'&&oldNode.rel==='stylesheet'){if(oldNode.href!==newNode.href){var l=newNode.cloneNode(true);l.href=new URL(newNode.getAttribute('href'),location.href).href;oldNode.replaceWith(l)}return}
 copyAttrs(newNode,oldNode);
 var a=Array.from(oldNode.childNodes),b=Array.from(newNode.childNodes),n=Math.min(a.length,b.length);
 for(var i=0;i<n;i++)sync(a[i],b[i]);
 for(var j=n;j<b.length;j++){if(b[j].nodeName!=='SCRIPT')oldNode.appendChild(b[j].cloneNode(true))}
 for(var k=a.length-1;k>=b.length;k--){if(a[k].nodeName!=='SCRIPT')a[k].remove()}
}
async function check(){
 if(busy||document.hidden)return;busy=true;
 try{
 var u=new URL(location.href);u.searchParams.set('__background_update',Date.now());
 var r=await fetch(u.href,{cache:'no-store',credentials:'same-origin',headers:{'X-Requested-With':'background-refresh'}});
 if(!r.ok)return;var html=await r.text();if(!html||html===last)return;last=html;
 var doc=new DOMParser().parseFromString(html,'text/html');
 if(doc.title&&doc.title!==document.title)document.title=doc.title;
 sync(document.body,doc.body);
 var oldMeta=document.querySelector('meta[name="theme-color"]'),newMeta=doc.querySelector('meta[name="theme-color"]');
 if(oldMeta&&newMeta)oldMeta.content=newMeta.content;
 }catch(e){ }finally{busy=false}
}
check();setInterval(check,5000);
document.addEventListener('visibilitychange',function(){if(!document.hidden)check()});
})();
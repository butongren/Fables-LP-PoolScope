'use strict';
const $=id=>document.getElementById(id), M=window.LPMath;
const nf=new Intl.NumberFormat('en-US',{maximumFractionDigits:2});
const money=v=>Number.isFinite(v)?'$'+nf.format(v):'—';
const dollars=v=>Number.isFinite(v)?(v<0?'−$':'$')+Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:6}):'—';
const number=v=>Number.isFinite(v)?v.toLocaleString('en-US',{maximumSignificantDigits:9}):'—';
const pct=v=>Number.isFinite(v)?(v!==0&&Math.abs(v)<.01?v.toLocaleString('en-US',{maximumSignificantDigits:3}):nf.format(v))+'%':'—';
const time=v=>v?new Date(v*1000).toLocaleString('zh-CN',{hour12:false}):'尚未成功读取';
const text=(id,v)=>$(id).textContent=v;
const el=(tag,content,cls)=>{const n=document.createElement(tag);if(content!==undefined)n.textContent=content;if(cls)n.className=cls;return n;};
let market=null, selected=null, chain=null, allocation=null, apr=null, profit=null;
let marketBusy=false,stateSequence=0,lastError='',toastTimer, presetWidth=.15;
let lossResult=null,lossPreset='below',quotePriceEdited=false;
let scenarios=[];
// One-time local origin migration. Fragment data never goes to the HTTP server.
if(location.port==='8767'&&location.hash.startsWith('#saved=')){
  try{const incoming=JSON.parse(decodeURIComponent(location.hash.slice(7)));const existing=JSON.parse(localStorage.getItem('fables-lp-scenarios-v1')||'[]');
    if(Array.isArray(incoming)&&Array.isArray(existing)){const combined=[...existing,...incoming];const unique=new Map(combined.filter(s=>s&&typeof s.id==='string').map(s=>[s.id,s]));localStorage.setItem('fables-lp-scenarios-v1',JSON.stringify([...unique.values()].slice(-60)));}
  }catch{}history.replaceState(null,'',location.pathname);
}
try{const saved=JSON.parse(localStorage.getItem('fables-lp-scenarios-v1')||'[]');if(Array.isArray(saved))scenarios=saved.filter(s=>s&&typeof s.id==='string'&&Array.isArray(s.profits)&&s.profits.length===9&&Number.isFinite(s.capital)&&Number.isFinite(s.apr)).slice(-60);}catch{}
function toast(message){text('toast',message);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3200);}
async function api(path){const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),55000);try{const r=await fetch(path,{signal:controller.signal});const data=await r.json();if(!r.ok||data.error&&data.value===undefined)throw Error(data.error||'读取失败');return data;}finally{clearTimeout(timer);}}
function currentPool(){return market?.pools.find(p=>p.id===selected);}
function notice(){
  const issues=[];
  if(lastError)issues.push((market?'联网更新暂未完成，保留已加载数据：':'尚未连接本机数据服务：')+lastError);
  if(market){for(const [key,s] of Object.entries(market.sources)){const label=({tvl:'TVL',volume:'交易量 / 手续费',marks:'市场价格',catalog:'池子目录'}[key]||key);if(s.stale)issues.push(label+'数据未更新（读取于 '+time(s.fetchedAt)+'）');if(s.missingRows)issues.push(label+'有 '+s.missingRows+' 个池子暂缺数据，缺失项显示为 —');}
    if(Date.now()/1000-market.servedAt>90)issues.push('市场数据已超过 90 秒未刷新');}
  $('globalNotice').hidden=!issues.length;text('globalNotice',issues.join('；'));
}
async function refresh(cached=false){
  cached=cached===true;
  if(marketBusy)return;marketBusy=true;$('refresh').disabled=true;text('syncStatus','正在同步 Fables 市场…');
  try{
    const next=await api('/api/markets'+(cached?'?cached=1':''));if(!Array.isArray(next.pools))throw Error('市场数据格式发生变化');market=next;lastError='';
    text('poolCount',market.pools.length);const values=key=>market.pools.map(p=>p[key]);
    for(const [key,id] of [['tvl','totalTvl'],['volume24h','totalVolume']]){const vs=values(key).filter(Number.isFinite);text(id,vs.length?money(vs.reduce((a,b)=>a+b,0))+(vs.length<market.pools.length?' *':''):'—');}
    text('syncStatus',Object.values(market.sources).some(s=>s.stale)?'部分数据未更新 · 见状态说明':'● 市场读取于 '+time(Math.min(...['tvl','volume','marks'].map(k=>market.sources[k].fetchedAt).filter(Boolean))));
    if(!currentPool()){const preferred=market.pools.find(p=>p.base.symbol==='ETH'&&p.quote.symbol==='USDG')||market.pools[0];if(preferred)selectPool(preferred.id);}
    else{renderHeader();calculate();loadState(selected);}
    renderPools();renderSources();
  }catch(e){lastError=e.name==='AbortError'?'连接超时':e.message;text('syncStatus','连接未更新 · 可手动重试');if(!market)$('poolList').replaceChildren(el('div','暂未取得市场数据。请检查网络后点击刷新。','empty'));}
  finally{marketBusy=false;$('refresh').disabled=false;notice();}
}
function renderSources(){const list=$('sourceDetails');list.replaceChildren();for(const [key,s] of Object.entries(market.sources)){list.append(el('p',key+'：'+time(s.fetchedAt)+(s.stale?' · 未更新 '+(s.error||''):' · 读取成功')));}}
function renderPools(){
  if(!market)return;
  const query=$('search').value.trim().toLowerCase(), category=$('category').value, key={tvl:'tvl',apr:'knownApr',volume:'volume24h'}[$('sort').value];
  const pools=market.pools.filter(p=>(category==='all'||p.category===category)&&[p.base.symbol,p.quote.symbol,p.name,p.id,p.base.address,p.quote.address].join(' ').toLowerCase().includes(query)).sort((a,b)=>(b[key]??-1)-(a[key]??-1));
  const list=$('poolList');list.replaceChildren();
  for(const p of pools){const btn=el('button',undefined,'poolbutton'+(p.id===selected?' selected':''));btn.setAttribute('aria-pressed',String(p.id===selected));btn.dataset.pool=p.id;
    const left=el('span');left.append(el('span',p.base.symbol+' / '+p.quote.symbol,'pair'),el('span','TVL '+money(p.tvl),'sub'));
    const right=el('span',pct(p.knownApr),'rate');right.append(el('small',p.aprComplete?'含已知奖励':'部分数据缺失'));
    btn.append(left,right);btn.onclick=()=>selectPool(p.id);list.append(btn);}
  if(!pools.length)list.append(el('div','没有匹配的池子','empty'));
}
function renderHeader(){const p=currentPool();if(!p)return;text('pairTitle',p.base.symbol+' / '+p.quote.symbol);text('pairName',p.name+' · Robinhood Chain');text('poolApr',pct(p.knownApr)+(p.aprComplete?'':' *'));text('fees',money(p.fees24h));text('tvl',money(p.tvl));text('priceUnit',p.quote.symbol+' / '+p.base.symbol);text('baseName',p.base.symbol);text('quoteName',p.quote.symbol);text('baseIcon',p.base.symbol.slice(0,1));text('quoteIcon',p.quote.symbol.slice(0,1));}
function selectPool(id){selected=id;chain=null;allocation=null;stateSequence++;presetWidth=.15;lossPreset='below';quotePriceEdited=false;$('futurePrice').value='';$('futureQuoteUsd').value='';renderHeader();renderPools();setBounds();calculate();loadState(id);}
function spotValue(){return chain?.value?.spot??currentPool()?.spot;}
function setBounds(){const p=spotValue();if(!Number.isFinite(p)||p<=0){$('lower').value='';$('upper').value='';return;} $('lower').value=Number((p*(1-presetWidth)).toPrecision(10));$('upper').value=Number((p*(1+presetWidth)).toPrecision(10));document.querySelectorAll('#rangePresets button').forEach(b=>b.classList.toggle('active',Number(b.dataset.width)===presetWidth));}
async function loadState(id){
  const seq=++stateSequence;text('stateStatus','正在读取链上价格和有效流动性…');
  try{const data=await api('/api/state?pool='+encodeURIComponent(id));if(seq!==stateSequence||id!==selected)return;chain=data;
    if(!$('lower').value||!$('upper').value)setBounds();
  }catch(e){if(seq!==stateSequence||id!==selected)return;chain={...(chain||{}),stale:true,error:e.message};}
  if(seq===stateSequence){renderState();calculate();}
}
function renderState(){
  if(!chain)return;
  const c=chain.value;const stale=chain.stale||!c||Date.now()/1000-chain.fetchedAt>90;
  text('stateStatus',c?(stale?'未更新 · ':'链上读取成功 · ')+'区块 '+c.block+' · '+time(chain.fetchedAt)+(c.multiplierError?' · 倍率读取失败，使用目录倍率':''):'链上数据暂不可用，可用市场价格测算配比；区间 APR 暂缺。');
  $('stateStatus').style.color=stale||c?.multiplierError?'var(--amber)':'';
}
function resetResult(message){
  allocation=null;apr=null;profit=null;$('saveScenario').disabled=true;
  for(const id of ['baseAmount','quoteAmount','baseValue','quoteValue','basePct','quotePct','rangeApr','efficiency','share','axisLower','axisUpper'])text(id,'—');
  text('baseRaw','');text('quoteRaw','');text('aprBreakdown','等待有效参数与数据');text('rangeBadge','无法测算');$('baseBar').style.width='0%';
  $('calcError').hidden=false;text('calcError',message);renderProjection();
}
function calculate(){
  const p=currentPool();if(!p)return;
  const current=spotValue();text('spotPrice',number(current));
  try{
    const pool=JSON.parse(JSON.stringify(p));
    for(const k of ['base','quote']){const t=pool[k];t.multiplier=chain?.value?.multipliers?.[t.address.toLowerCase()]||t.multiplier;}
    let quoteUsd=p.quoteUsd;
    // Keep the same dollar value per raw ERC20 unit when a display multiplier changes.
    if(Number.isFinite(quoteUsd))quoteUsd*=Number(p.quote.multiplier)/Number(pool.quote.multiplier);
    if(!Number.isFinite(quoteUsd)&&Number.isFinite(p.baseUsd))quoteUsd=p.baseUsd/current;
    const capital=Number($('capital').value),lower=Number($('lower').value),upper=Number($('upper').value);
    allocation=M.allocation(pool,current,lower,upper,capital,quoteUsd);
    apr=M.rangeApr(p,allocation,capital,chain?.value?.activeLiquidity);
    const a=allocation;
    $('calcError').hidden=true;text('baseAmount',number(a.base));text('quoteAmount',number(a.quote));text('baseValue',money(a.baseValue));text('quoteValue',money(a.quoteValue));text('basePct',pct(a.basePercent));text('quotePct',pct(100-a.basePercent));
    text('baseRaw',Number(pool.base.multiplier)!==1e18?'合约单位 '+number(a.baseRawUnits):'');text('quoteRaw',Number(pool.quote.multiplier)!==1e18?'合约单位 '+number(a.quoteRawUnits):'');
    $('baseBar').style.width=Math.max(0,Math.min(100,a.basePercent))+'%';text('rangeBadge',a.inRange?'价格在区间内':'区间外 · 单币');$('rangeBadge').classList.toggle('warn',!a.inRange);
    text('allocationNote',a.inRange?'按当前价格估值，以上两种代币合计 '+money(capital)+'。': '当前价格位于区间外，初始为单币仓位。价格进入区间前不产生交易手续费。');
    text('efficiency',nf.format(a.efficiency)+'×');text('share',apr?pct(apr.share*100):'—');text('axisLower',number(a.lower));text('axisUpper',number(a.upper));
    const position=(Math.log(current)-Math.log(a.lower))/(Math.log(a.upper)-Math.log(a.lower));$('priceMarker').style.left=Math.max(0,Math.min(100,position*100))+'%';
    text('alignment','实际区间 '+number(a.lower)+' — '+number(a.upper)+' '+p.quote.symbol+' / '+p.base.symbol+' · Tick '+a.ticks.join(' / '));
    text('rangeApr',apr?pct(apr.total)+(apr.complete?'':' *'):'暂缺');
    text('aprBreakdown',apr?'手续费 '+pct(apr.swap)+' + 创作者奖励 '+pct(apr.creator)+' + 额外奖励 '+pct(apr.partner)+(apr.complete?'':'。* 未知奖励未计入')+(chain?.stale?' · 使用未更新的链上数据':''):'缺少链上流动性或手续费数据，可切换手动 APR 测算。');
    renderProjection();
  }catch(e){resetResult(e.message);}
}
function renderProjection(){
  const p=currentPool(), mode=$('aprMode').value;
  $('aprInput').disabled=mode!=='manual';
  const used=mode==='manual'?($('aprInput').value.trim()===''?null:Number($('aprInput').value)):mode==='pool'?p?.knownApr:apr?.total;
  if(mode!=='manual')$('aprInput').value=Number.isFinite(used)?Number(used.toFixed(6)):'';
  const rows=$('profitRows');rows.replaceChildren();profit=null;
  try{
    if(!Number.isFinite(used))throw Error('当前 APR 数据不足。可切换到「手动 APR 情景」输入假设值。');
    if($('activeTime').value.trim()===''||$('cost').value.trim()==='')throw Error('请填写在区间时间比例和一次性成本');
    profit=M.project(Number($('capital').value),used,Number($('activeTime').value),Number($('cost').value));
    for(const v of profit){const tr=el('tr');tr.append(el('td',v.label),el('td',dollars(v.gross)),el('td',dollars(v.net),v.net>=0?'profit':'negative'),el('td',pct(v.roi)));rows.append(tr);}
    $('projectionError').hidden=true;
  }catch(e){$('projectionError').hidden=false;text('projectionError',e.message);}
  let notes='固定 APR 情景：假设所选 '+(Number.isFinite(used)?pct(used):'APR')+' 在整个测算期不变，不复利；净额扣除所填的一次性成本，不含币价盈亏或无常损失。';
  if(mode==='pool')notes+=' 池子整体 APR 仅作基准，未按所选区间调整。';
  if(mode==='manual')notes+=' 手动 APR 为你的假设，不是平台报价。';
  if(mode!=='manual'&&market?.rewardWeekEnds&&(p?.creatorApr>0||p?.partnerApr>0))notes+=' 当前奖励周截至 '+time(market.rewardWeekEnds)+'，跨周收益只是当前 APR 延续的假设。';
  if(mode!=='manual'&&p&&!p.aprComplete)notes+=' 存在未知奖励，仅测算已知部分。';
  if(allocation&&!allocation.inRange&&mode!=='range')notes+=' 当前所选区间外，实际当下手续费为 0；本表是假设性基准。';
  text('projectionNote',notes);$('saveScenario').disabled=!(allocation&&profit);renderLoss();
}
function renderLoss(){
  lossResult=null;$('saveLossScenario').disabled=true;
  try{
    const a=allocation,p=currentPool();if(!a||!p)throw Error('请先在上方设置有效的资金与区间');
    text('lossUnit',p.quote.symbol+' / '+p.base.symbol);text('futureQuoteLabel',p.quote.symbol+' 届时价格 USD');
    if(!quotePriceEdited)$('futureQuoteUsd').value=Number(a.quoteUsd.toPrecision(12));
    if(lossPreset!==null){const target=lossPreset==='below'?a.lower*.9:lossPreset==='lower'?a.lower:a.entryPrice*(1+Number(lossPreset)/100);$('futurePrice').value=target;}
    document.querySelectorAll('#lossPresets button').forEach(b=>b.classList.toggle('active',b.dataset.loss===lossPreset));
    if(['futurePrice','futureQuoteUsd','earnedFees','cost'].some(id=>$(id).value.trim()===''))throw Error('请填写假设价格、计价币美元价格、累计收入和成本');
    const price=Number($('futurePrice').value),qUsd=Number($('futureQuoteUsd').value),earned=Number($('earnedFees').value),cost=Number($('cost').value);
    const r=M.impermanentLoss(a,price,qUsd,earned,cost);lossResult=r;
    $('lossError').hidden=true;$('lossResults').hidden=false;
    text('lossBadge',r.region==='below'?'到达 / 跌破下界 · 单币':r.region==='above'?'到达 / 突破上界 · 单币':'仍在区间内');$('lossBadge').classList.toggle('warn',r.region!=='inside');
    text('lossAssumption','入场价 '+number(a.entryPrice)+' → 假设价 '+number(price)+'（'+pct(r.priceChange)+'）；计价币美元价格 '+money(a.quoteUsd)+' → '+money(qUsd)+'。');
    text('lossLpValue',dollars(r.lpValue));text('lossHoldValue',dollars(r.holdValue));text('lossDifference',dollars(r.difference));
    text('lossTokens',number(r.base)+' '+p.base.symbol+' + '+number(r.quote)+' '+p.quote.symbol);
    text('lossPercent',r.ilPercent===null?'直接持有价值为 0，比例不适用':'相对直接持有 '+pct(r.ilPercent));
    text('lossPnl',dollars(r.pnl)+' / '+pct(r.pnlPercent));text('lossNetPnl',dollars(r.netPnl)+' / '+pct(r.netPercent));
    for(const [id,v] of [['lossDifference',r.difference],['lossPnl',r.pnl],['lossNetPnl',r.netPnl]])$(id).className=v<0?'negative':'profit';
    const rows=$('lossRows');rows.replaceChildren();
    const cases=[['价格不变',a.entryPrice],['刚到区间下界',a.lower],['下界再跌 10%',a.lower*.9],['下界再跌 25%',a.lower*.75],['下界再跌 50%',a.lower*.5],['你的假设',price]];
    for(const [label,target] of cases){const v=M.impermanentLoss(a,target,qUsd,earned,cost),tr=el('tr');tr.append(el('td',label),el('td',number(target)),el('td',pct(v.priceChange)),el('td',dollars(v.lpValue)),el('td',dollars(v.holdValue)),el('td',dollars(v.difference)+' / '+pct(v.ilPercent),v.difference<0?'negative':''),el('td',dollars(v.pnl),v.pnl<0?'negative':'profit'));rows.append(tr);}
    $('saveLossScenario').disabled=!profit;
  }catch(e){$('lossError').hidden=false;text('lossError',e.message);$('lossResults').hidden=true;text('lossBadge','等待有效参数');}
}
function persist(){try{localStorage.setItem('fables-lp-scenarios-v1',JSON.stringify(scenarios));return true;}catch{toast('浏览器存储不可用，请导出 CSV 保存方案');return false;}}
function saveScenario(){
  if(!allocation||!profit)return;
  if(scenarios.length>=60){toast('最多保存 60 个方案，请先导出并删除旧方案');return;}
  const p=currentPool(), mode=$('aprMode').value;
  scenarios.push({id:Date.now().toString(36)+Math.random().toString(36).slice(2,7),pool:p.base.symbol+'/'+p.quote.symbol,poolId:p.id,
    createdAt:Date.now()/1000,observedAt:chain?.fetchedAt||market.sources.marks.fetchedAt,
    sourceStale:!!(chain?.stale||lastError||Date.now()/1000-market.servedAt>90||(chain?.fetchedAt&&Date.now()/1000-chain.fetchedAt>90)||Object.values(market.sources).some(s=>s.stale)),
    lower:allocation.lower,upper:allocation.upper,capital:Number($('capital').value),
    base:allocation.base,quote:allocation.quote,baseSymbol:p.base.symbol,quoteSymbol:p.quote.symbol,
    baseRaw:allocation.baseRawUnits,quoteRaw:allocation.quoteRawUnits,basePercent:allocation.basePercent,
    apr:mode==='manual'?Number($('aprInput').value):mode==='pool'?p.knownApr:apr.total,
    mode,active:Number($('activeTime').value),cost:Number($('cost').value),profits:profit.map(r=>({...r})),loss:lossResult?{...lossResult,entryPrice:allocation.entryPrice,entryQuoteUsd:allocation.quoteUsd}:null});
  const saved=persist();renderScenarios();if(saved)toast('已保存方案，可继续更换池子或参数比较');
}
function renderScenarios(){
  const head=el('tr');for(const title of ['池子 / 区间','投入 / 配比','APR / 假设','假设价格 / 无常损失',...M.intervals.map(v=>v[0]+'净额'),'操作'])head.append(el('th',title));$('scenarioHead').replaceChildren(head);
  const body=$('scenarioRows');body.replaceChildren();$('emptyScenarios').hidden=!!scenarios.length;$('export').disabled=!scenarios.length;
  for(const s of scenarios){const tr=el('tr'), pair=el('td',s.pool);pair.append(el('small',number(s.lower)+' — '+number(s.upper)),el('small',time(s.createdAt)),el('small',s.sourceStale?'保存时含未更新数据':'保存时的数据快照'));
    const cap=el('td',money(s.capital));cap.append(el('small',number(s.base)+' '+s.baseSymbol),el('small',number(s.quote)+' '+s.quoteSymbol));
    const rate=el('td',pct(s.apr));rate.append(el('small',({range:'区间 APR',pool:'整体 APR 基准',manual:'手动 APR 情景'}[s.mode]||'快照')+' · 在区间 '+s.active+'%'),el('small','成本 '+money(s.cost)));
    const lossCell=el('td',s.loss?number(s.loss.futurePrice):'未记录');if(s.loss)lossCell.append(el('small','无常损失 '+dollars(s.loss.difference)+' / '+pct(s.loss.ilPercent)),el('small','本金盈亏 '+dollars(s.loss.pnl)),el('small','含收入与成本 '+dollars(s.loss.netPnl)));
    tr.append(pair,cap,rate,lossCell);for(const v of s.profits)tr.append(el('td',dollars(v.net),v.net>=0?'profit':'negative'));
    const action=el('td'),remove=el('button','删除');remove.onclick=()=>{scenarios=scenarios.filter(x=>x.id!==s.id);persist();renderScenarios();};action.append(remove);tr.append(action);body.append(tr);}
}
function exportCsv(){
  if(!scenarios.length)return;
  const headers=['池子','Pool ID','保存时间','数据读取时间','含未更新数据','实际最低价','实际最高价','投入USD','左币种','左币数量(显示单位)','左币合约单位','左币价值占比%','右币种','右币数量(显示单位)','右币合约单位','APR%','APR口径','在区间时间%','一次性成本USD',...M.intervals.flatMap(v=>[v[0]+'毛收入USD',v[0]+'净额USD'])];
  const values=scenarios.map(s=>[s.pool,s.poolId,new Date(s.createdAt*1000).toISOString(),new Date(s.observedAt*1000).toISOString(),s.sourceStale?'是':'否',s.lower,s.upper,s.capital,s.baseSymbol,s.base,s.baseRaw,s.basePercent,s.quoteSymbol,s.quote,s.quoteRaw,s.apr,s.mode,s.active,s.cost,...s.profits.flatMap(v=>[v.gross,v.net])]);
  headers.push('损失测算入场价格','入场计价币USD','假设价格','假设计价币USD','变动后左币数量','变动后右币数量','LP价值USD','直接持有价值USD','无常损失USD(LP-持有)','无常损失%','本金盈亏USD','累计收入USD','含收入扣成本后盈亏USD');
  scenarios.forEach((s,i)=>{const r=s.loss;values[i].push(...(r?[r.entryPrice,r.entryQuoteUsd,r.futurePrice,r.futureQuoteUsd,r.base,r.quote,r.lpValue,r.holdValue,r.difference,r.ilPercent,r.pnl,r.earned,r.netPnl]:Array(13).fill('')));});
  function quote(v){let value=String(v??'');if(typeof v==='string'&&/^[=+@\-\t\r]/.test(value))value="'"+value;return '"'+value.replaceAll('"','""')+'"';}
  const blob=new Blob(['\ufeff'+[headers,...values].map(r=>r.map(quote).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download='Fables-LP-方案-'+new Date().toISOString().slice(0,10)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
}
$('refresh').onclick=refresh;
for(const id of ['search','category','sort'])$(id).addEventListener('input',renderPools);
for(const id of ['capital','lower','upper'])$(id).addEventListener('input',()=>{if(id!=='capital')document.querySelectorAll('#rangePresets button').forEach(b=>b.classList.remove('active'));calculate();});
for(const id of ['aprInput','activeTime','cost'])$(id).addEventListener('input',renderProjection);
$('aprMode').onchange=()=>{if($('aprMode').value==='manual'&&!$('aprInput').value)$('aprInput').value='50';renderProjection();};
$('rangePresets').onclick=e=>{if(!e.target.dataset.width)return;presetWidth=Number(e.target.dataset.width);setBounds();calculate();};
$('capitalPresets').onclick=e=>{if(!e.target.dataset.value)return;$('capital').value=e.target.dataset.value;calculate();};
$('saveScenario').onclick=saveScenario;$('export').onclick=exportCsv;
$('saveLossScenario').onclick=saveScenario;
$('futurePrice').oninput=()=>{lossPreset=null;renderLoss();};
$('futureQuoteUsd').oninput=()=>{quotePriceEdited=true;renderLoss();};
$('earnedFees').oninput=renderLoss;
$('lossPresets').onclick=e=>{if(e.target.dataset.loss===undefined)return;lossPreset=e.target.dataset.loss;renderLoss();};
$('auto').onchange=()=>{if($('auto').checked)refresh();};
setInterval(()=>{notice();renderState();if($('auto').checked&&!document.hidden)refresh();},30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&$('auto').checked)refresh();});
if(location.port==='8766'){
  let saved='[]';try{saved=localStorage.getItem('fables-lp-scenarios-v1')||'[]';}catch{}
  location.replace('http://127.0.0.1:8767/#saved='+encodeURIComponent(saved));
}else{renderScenarios();refresh(true).then(()=>refresh());}

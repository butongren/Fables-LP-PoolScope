/* Independent implementation of concentrated liquidity amounts; prices are quote/base. */
(function (root) {
  'use strict';
  const intervals = [['10 分钟',10],['30 分钟',30],['1 小时',60],['4 小时',240],['8 小时',480],['12 小时',720],['24 小时',1440],['15 天',21600],['30 天',43200]];
  function requirePositive(value, name) {
    if (!Number.isFinite(value) || value <= 0) throw Error(name + '必须大于 0');
  }
  function allocation(pool, current, lower, upper, capital, quoteUsd) {
    [ [current,'当前价格'],[lower,'最低价'],[upper,'最高价'],[capital,'投入金额'],[quoteUsd,'计价币美元价格'] ].forEach(([v,n])=>requirePositive(v,n));
    if(lower >= upper) throw Error('最低价必须小于最高价');
    const b=pool.base, q=pool.quote, base0=BigInt(b.address)<BigInt(q.address);
    const mb=Number(b.multiplier)/1e18, mq=Number(q.multiplier)/1e18;
    const toRaw = p => base0 ? p*10**(q.decimals-b.decimals)*mb/mq : 1/p*10**(b.decimals-q.decimals)*mq/mb;
    const fromRaw = p => base0 ? p*10**(b.decimals-q.decimals)*mq/mb : 1/p*10**(b.decimals-q.decimals)*mq/mb;
    const spacing=pool.tickSpacing, log=Math.log(1.0001);
    let ticks=[lower,upper].map(p=>Math.round(Math.log(toRaw(p))/log/spacing)*spacing).sort((a,b)=>a-b);
    const limit=Math.floor(887272/spacing)*spacing;
    if(ticks[0]<-limit || ticks[1]>limit) throw Error('所选价格超出池子的有效 Tick 范围');
    if(ticks[0]===ticks[1]) throw Error('区间过窄：按该池价格刻度对齐后上下界相同');
    const ra=Math.exp(ticks[0]*log/2), rb=Math.exp(ticks[1]*log/2), r=Math.sqrt(toRaw(current));
    const clamped=Math.min(rb,Math.max(ra,r));
    const c0=(rb-clamped)/(clamped*rb), c1=clamped-ra;
    const cb=(base0?c0:c1)/10**b.decimals*mb, cq=(base0?c1:c0)/10**q.decimals*mq;
    const baseUsd=current*quoteUsd, value=cb*baseUsd+cq*quoteUsd;
    requirePositive(value,'单位流动性价值');
    const liquidity=capital/value, base=liquidity*cb, quote=liquidity*cq;
    if(![liquidity,base,quote].every(Number.isFinite)) throw Error('数值过大，请缩小测算范围');
    const actual=[fromRaw(ra*ra),fromRaw(rb*rb)].sort((a,b)=>a-b);
    return {base,quote,baseRawUnits:base/mb,quoteRawUnits:quote/mq,baseValue:base*baseUsd,quoteValue:quote*quoteUsd,
      basePercent:base*baseUsd/capital*100,liquidity,lower:actual[0],upper:actual[1],ticks,
      entryPrice:current,quoteUsd,capital,
      inRange:r>=ra&&r<rb,efficiency:1/(1-Math.exp((ticks[0]-ticks[1])*log/4))};
  }
  function rangeApr(pool, a, capital, activeLiquidity) {
    if(pool.fees24h===null || !Number.isFinite(pool.fees24h) || pool.fees24h<0 || activeLiquidity===null || activeLiquidity===undefined) return null;
    const active=Number(activeLiquidity);
    if(!Number.isFinite(active)||active<0) return null;
    const share=a.inRange?a.liquidity/(active+a.liquidity):0;
    const swap=pool.fees24h*share*365/capital*100;
    const creator=pool.creatorFactor===null?null:swap*pool.creatorFactor;
    // Partner USDG incentives follow earned swap fees, as in the official range view.
    const partner=pool.partnerDaily===null?null:!a.inRange?0:pool.partnerDaily===0?0:
      pool.fees24h>0?swap*pool.partnerDaily/pool.fees24h:null;
    return {swap,creator,partner,total:swap+(creator||0)+(partner||0),share,complete:creator!==null&&partner!==null};
  }
  function project(capital, apr, activePercent, cost) {
    requirePositive(capital,'投入金额');
    if(!Number.isFinite(apr)||apr<0 || !Number.isFinite(cost)||cost<0 || !Number.isFinite(activePercent)||activePercent<0||activePercent>100) throw Error('APR、成本或在区间时间比例无效');
    return intervals.map(([label,minutes])=>{
      const gross=capital*apr/100*minutes/525600*activePercent/100;
      return {label,minutes,gross,net:gross-cost,roi:(gross-cost)/capital*100};
    });
  }
  function impermanentLoss(initial, futurePrice, futureQuoteUsd, earned=0, cost=0) {
    if(!initial)throw Error('请先设置有效的投入金额与价格区间');
    if(!Number.isFinite(futurePrice)||futurePrice<0)throw Error('假设价格必须大于或等于 0');
    requirePositive(futureQuoteUsd,'假设计价币美元价格');
    if(!Number.isFinite(earned)||earned<0||!Number.isFinite(cost)||cost<0)throw Error('累计收入和成本必须为非负数');
    const {lower,upper,entryPrice,quoteUsd,capital}=initial;
    const a=Math.sqrt(lower),b=Math.sqrt(upper);
    const amounts=p=>{const c=Math.max(a,Math.min(b,Math.sqrt(p)));return [(b-c)/(c*b),c-a];};
    const [x,y]=amounts(entryPrice);
    // Preserve the original position's liquidity; do not reinvest its capital at the future price.
    const L=capital/(quoteUsd*(entryPrice*x+y));
    const [cx,cy]=amounts(futurePrice),base=L*cx,quote=L*cy;
    const lpValue=(base*futurePrice+quote)*futureQuoteUsd;
    const holdValue=(initial.base*futurePrice+initial.quote)*futureQuoteUsd;
    let difference=lpValue-holdValue;
    if(Math.abs(difference)<1e-10*Math.max(capital,holdValue,1))difference=0;
    const rawPnl=lpValue-capital;
    const pnl=Math.abs(rawPnl)<1e-10*Math.max(capital,1)?0:rawPnl,netPnl=pnl+earned-cost;
    const result={futurePrice,futureQuoteUsd,earned,cost,base,quote,lpValue,holdValue,difference,
      ilPercent:holdValue>0?difference/holdValue*100:null,pnl,pnlPercent:pnl/capital*100,
      netPnl,netPercent:netPnl/capital*100,priceChange:(futurePrice/entryPrice-1)*100,
      region:futurePrice<=lower?'below':futurePrice>=upper?'above':'inside'};
    if(![base,quote,lpValue,holdValue,pnl,netPnl].every(Number.isFinite))throw Error('数值过大，请缩小测算范围');
    return result;
  }
  root.LPMath={allocation,rangeApr,project,impermanentLoss,intervals};
})(typeof window==='undefined'?globalThis:window);

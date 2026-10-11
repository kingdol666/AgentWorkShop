const fs=require('fs'),zlib=require('zlib');
function decode(file){
  const b=fs.readFileSync(file);let off=8,W,H,idat=[];
  while(off<b.length){const len=b.readUInt32BE(off),type=b.toString('ascii',off+4,off+8);
    if(type==='IHDR'){W=b.readUInt32BE(off+8);H=b.readUInt32BE(off+12);}
    else if(type==='IDAT'){idat.push(b.slice(off+8,off+8+len));}
    off+=12+len;}
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const stride=W*3;const out=Buffer.alloc(stride*H);
  let p=0;
  for(let y=0;y<H;y++){const f=raw[p++];const row=raw.slice(p,p+stride);p+=stride;
    const prev=y>0?out.slice((y-1)*stride,y*stride):Buffer.alloc(stride);
    const cur=out.slice(y*stride,(y+1)*stride);
    for(let x=0;x<stride;x++){const a=x>=3?cur[x-3]:0,bb=prev[x],c=x>=3?prev[x-3]:0;let v=row[x];
      if(f===1)v=(v+a)&255;else if(f===2)v=(v+bb)&255;else if(f===3)v=(v+((a+bb)>>1))&255;
      else if(f===4){const pa=Math.abs(bb-c),pb=Math.abs(a-c),pc=Math.abs(a+bb-2*c);v=(v+(pa<=pb&&pa<=pc?a:pb<=pc?bb:c))&255;}
      cur[x]=v;}}
  return {W,H,data:out};
}
function crcBuf(buf){let c=~0;for(let i=0;i<buf.length;i++){c^=buf[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}c=~c;const r=Buffer.alloc(4);r.writeUInt32BE(c>>>0);return r;}
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type);return Buffer.concat([len,t,data,crcBuf(Buffer.concat([t,data]))]);}
function encode(W,H,data,file){
  const stride=W*3;const raw=Buffer.alloc((stride+1)*H);
  for(let y=0;y<H;y++){raw[y*(stride+1)]=0;data.copy(raw,y*(stride+1)+1,y*stride,(y+1)*stride);}
  const idat=zlib.deflateSync(raw,{level:9});
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=2;
  fs.writeFileSync(file,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))]));
}
function crop(src,x0,y0,x1,y1,scale,out){
  const {W,H,data}=decode(src);
  const cw=x1-x0,ch=y1-y0;const cd=Buffer.alloc(cw*ch*3);
  for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){const si=((y0+y)*W+(x0+x))*3;const di=(y*cw+x)*3;cd[di]=data[si];cd[di+1]=data[si+1];cd[di+2]=data[si+2];}
  const up=Buffer.alloc(cw*scale*ch*scale*3);
  for(let y=0;y<ch*scale;y++)for(let x=0;x<cw*scale;x++){const si=((y/scale|0)*cw+(x/scale|0))*3;const di=(y*cw*scale+x)*3;up[di]=cd[si];up[di+1]=cd[si+1];up[di+2]=cd[si+2];}
  encode(cw*scale,ch*scale,up,out);
  console.log('wrote',out,cw*scale,'x',ch*scale);
}
const [,,src,x0,y0,x1,y1,scale,out]=process.argv;
crop(src,+x0,+y0,+x1,+y1,+scale,out);

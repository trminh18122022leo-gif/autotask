/** Offline verification, uses globally installed TypeScript if npm dependencies unavailable.
    Not a replacement for `npm run typecheck` with real dependencies.
*/
const fs=require('fs'),path=require('path');
let ts;try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
let count=0;const diagnostics=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith('.ts')){
  const relative=p.replace(/\\/g,'/');const content=fs.readFileSync(p,'utf8');
  const output=ts.transpileModule(content,{fileName:p,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler}});
  const errs=(output.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error);
  for(const d of errs)diagnostics.push({file:relative,message:ts.flattenDiagnosticMessageText(d.messageText,' ')});
  const target=path.join('dist',p).replace(/\.ts$/,'.js');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,output.outputText);count++;
}}}
walk('src');walk('tests');console.log(JSON.stringify({transpiled:count,syntaxErrors:diagnostics.length,diagnostics},null,2));if(diagnostics.length)process.exitCode=1;

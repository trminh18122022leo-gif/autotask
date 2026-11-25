/** Explicit completion guards, separately testable without a browser. */
export function hasUnvisitedPages(pageIndex:number,maxPages:number,nextExists:boolean):boolean {
 if(!Number.isInteger(pageIndex)||pageIndex<0||!Number.isInteger(maxPages)||maxPages<1)throw new Error('Invalid pagination');
 return pageIndex===maxPages-1&&nextExists;
}
export function readyForReview(args:{supported:boolean;complete:boolean;filled:number;found:number;waiting:boolean}):boolean {
 return !args.waiting&&args.supported&&args.complete&&args.found>0&&args.filled===args.found;
}

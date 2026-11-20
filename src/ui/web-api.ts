import type { CatalogFilters, DesktopApi } from '../contracts';

type WebApi = Pick<DesktopApi,'loadCatalogFilters'|'saveCatalogFilters'|'list'|'detail'|'updateTags'|'updateDescription'|'export'> & {
  status(): Promise<{configured:boolean}>;
};

async function request<T>(route:string, method='GET', body?:unknown):Promise<T> {
  const response = await fetch('/api'+route,{
    method,
    ...(body===undefined ? {} : {
      headers:{'content-type':'application/json','x-vfx-web':'1'},
      body:JSON.stringify(body),
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message??`请求失败（${response.status}）`);
  return result as T;
}

const template = (id:string) => '/templates/'+encodeURIComponent(id);
let filters:CatalogFilters = {mode:'any',tags:[]};

export const webApi:WebApi = {
  status:()=>request('/status'),
  async loadCatalogFilters() { return filters; },
  async saveCatalogFilters(next) { filters = next; },
  list:input=>request('/library','POST',input),
  detail:id=>request(template(id)),
  updateTags:(id,tags)=>request(template(id)+'/tags','PUT',{tags}),
  updateDescription:(id,description)=>request(template(id)+'/description','PUT',{description}),
  async export(id,mode) {
    const link = document.createElement('a');
    link.href = '/api'+template(id)+'/package?mode='+mode;
    link.download = '';
    link.click();
    return undefined;
  },
};

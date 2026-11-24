// Stock routes. Bartenders take deliveries, write off breakage and count the shelf. Managers and the owner
// also set up the stock items and recipes, see what things cost, and put mistakes right.
import { int } from './http.js';
import * as stock from './services/stock.js';

const SHELF = ['bartender', 'manager', 'owner'];
const BOSS = ['manager', 'owner'];

export function registerStockRoutes(r) {
  r.get('/api/stock', { roles: SHELF }, (c) => stock.overview(c.user));
  r.get('/api/stock/alerts', { roles: SHELF }, () => stock.openAlerts());
  r.post('/api/stock/deliveries', { roles: SHELF }, (c) => stock.deliver(c, c.body));
  r.post('/api/stock/waste', { roles: SHELF }, (c) => stock.waste(c, c.body));
  r.post('/api/stock/counts', { roles: SHELF }, (c) => stock.count(c, c.body));
  r.post('/api/stock/alerts/:id/seen', { roles: SHELF }, (c) => stock.seeAlert(c, int(c.params.id, 'id')));
  r.get('/api/stock/shopping-list', { roles: SHELF }, () => stock.shoppingList());
  r.post('/api/stock/shopping-list/print', { roles: SHELF }, (c) => stock.printShoppingList(c));

  r.get('/api/stock/moves', { roles: BOSS }, (c) => stock.moves(c.query));
  r.post('/api/stock/moves/:id/correct', { roles: BOSS }, (c) => stock.correct(c, int(c.params.id, 'id')));
  r.post('/api/stock/items', { roles: BOSS }, (c) => stock.saveItem(c, null, c.body));
  r.put('/api/stock/items/:id', { roles: BOSS }, (c) => stock.saveItem(c, int(c.params.id, 'id'), c.body));
  r.put('/api/stock/recipes/:owner/:id', { roles: BOSS }, (c) => stock.setRecipe(c, c.params.owner, int(c.params.id, 'id'), c.body.lines));
  r.get('/api/stock/setup', { roles: BOSS }, () => stock.setupProposal());
  r.post('/api/stock/setup', { roles: BOSS }, (c) => stock.setup(c, c.body));
}

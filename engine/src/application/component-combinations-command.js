import { isFigmaCommandPlan } from "../../../src/capability-catalog.js";
import { NODE_REFERENCE_PATTERN } from "./node-reference.js";
import {
  componentCombinationsArgvFromRequest,
  componentCombinationsPlanningArgvFromRequest,
  parseComponentCombinationsRequest,
} from "./component-combinations-request.js";

const APPLICATION_ID = "combos";
export const MAX_COMPONENT_COMBINATIONS_PROPERTIES = 8;
export const MAX_COMPONENT_COMBINATIONS_OPTIONS = 16;
export const MAX_COMPONENT_COMBINATIONS = 256;
export const MAX_COMPONENT_COMBINATIONS_CHILDREN = 2_000;
export const MAX_COMPONENT_COMBINATIONS_NAME_CODE_UNITS = 512;
export const MAX_COMPONENT_COMBINATIONS_OPTION_CODE_UNITS = 256;
export const MAX_COMPONENT_COMBINATIONS_RESULT_CODE_UNITS = 96_000;
export const MAX_COMPONENT_COMBINATIONS_GEOMETRY = 100_000_000;
const MAX_OWNED_IDS = 1_280;
const MAX_ATTEMPTS =
  MAX_COMPONENT_COMBINATIONS * 2 + MAX_COMPONENT_COMBINATIONS_OPTIONS;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;
const WARNINGS = new Set([
  "Generated nodes were verified, but selection could not be updated.",
  "Generated nodes were verified, but selection could not be updated exactly.",
  "Generated nodes were verified, but viewport focus could not be updated.",
]);

const normalized = (request) =>
  parseComponentCombinationsRequest(
    componentCombinationsArgvFromRequest(request)
  );

const jsValue = (value) =>
  JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

export {
  componentCombinationsArgvFromRequest,
  componentCombinationsPlanningArgvFromRequest,
};

export function componentCombinationsCode(request) {
  const input = normalized(request);
  return `(async()=>{
    const input=${jsValue(input)};
    const MAX_PROPERTIES=${MAX_COMPONENT_COMBINATIONS_PROPERTIES};
    const MAX_OPTIONS=${MAX_COMPONENT_COMBINATIONS_OPTIONS};
    const MAX_COMBINATIONS=${MAX_COMPONENT_COMBINATIONS};
    const MAX_CHILDREN=${MAX_COMPONENT_COMBINATIONS_CHILDREN};
    const MAX_NAME=${MAX_COMPONENT_COMBINATIONS_NAME_CODE_UNITS};
    const MAX_OPTION=${MAX_COMPONENT_COMBINATIONS_OPTION_CODE_UNITS};
    const MAX_OWNED=${MAX_OWNED_IDS};
    const unsafe=/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/;
    const clean=(value,maximum=MAX_NAME)=>String(value??'').slice(0,maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g,' ');
    const bounded=(value)=>{const raw=JSON.stringify(value);if(raw.length>${MAX_COMPONENT_COMBINATIONS_RESULT_CODE_UNITS})throw new Error('Component Combinations result exceeded its bound.');return raw};
    const refusal=(value)=>bounded({schemaVersion:1,status:'refused',outcome:'no-mutation',attempted:0,failure:clean(value&&value.message?value.message:value,1024)});
    const ownProperty=(record,key)=>record&&Object.prototype.hasOwnProperty.call(record,key);
    const ids=(node,label)=>{if(!node||!Array.isArray(node.children)||node.children.length>MAX_CHILDREN)throw new Error(label+' children are unavailable or excessive.');const values=node.children.map(child=>child&&child.id);if(values.some(id=>typeof id!=='string')||new Set(values).size!==values.length)throw new Error(label+' child identities are invalid.');return values};
    const same=(left,right)=>left.length===right.length&&left.every((id,index)=>id===right[index]);
    const finite=(value)=>Number.isFinite(value)&&Math.abs(value)<=${MAX_COMPONENT_COMBINATIONS_GEOMETRY};
    let attempted=0;
    let source=null,componentSet=null,defaultVariant=null,page=null;
    let beforePageIds=[],beforeSelectionIds=[],ownedIds=[];
    try {
      source=input.nodeId?await figma.getNodeByIdAsync(input.nodeId):figma.currentPage.selection[0];
      if(!source)return refusal('No component selected. Select a Component Set, Variant, or Instance.');
      if(source.type==='COMPONENT_SET')componentSet=source;
      else if(source.type==='COMPONENT'&&source.parent&&source.parent.type==='COMPONENT_SET')componentSet=source.parent;
      else if(source.type==='INSTANCE'){
        const main=await source.getMainComponentAsync();
        if(main&&main.parent&&main.parent.type==='COMPONENT_SET')componentSet=main.parent;
      }
      if(!componentSet)return refusal('Selected node is not a Component Set, Variant, or compatible Instance.');
      page=figma.currentPage;
      const pageIds=ids(page,'Current page');
      let ancestor=componentSet,depth=0;
      while(ancestor&&ancestor.id!==page.id&&ancestor.parent&&depth++<64)ancestor=ancestor.parent;
      if(!ancestor||ancestor.id!==page.id)return refusal('Component Set is not on the current page.');
      if(typeof componentSet.name!=='string'||!componentSet.name||componentSet.name.length>MAX_NAME||unsafe.test(componentSet.name))return refusal('Component Set name is invalid or excessive.');
      const setChildren=ids(componentSet,'Component Set');
      const definitions=componentSet.componentPropertyDefinitions;
      if(!definitions||typeof definitions!=='object'||Array.isArray(definitions))return refusal('Component Set has no property definitions.');
      const entries=Object.entries(definitions);
      if(entries.length>MAX_PROPERTIES)return refusal('Component Set has too many properties for bounded combination generation.');
      const properties=[];
      let total=1;
      for(const [name,definition] of entries){
        if(typeof name!=='string'||!name||name.length>MAX_NAME||unsafe.test(name)||!definition||typeof definition!=='object'||Array.isArray(definition))return refusal('Component Set property definitions are malformed.');
        let options=null,type=null;
        if(definition.type==='VARIANT'){options=definition.variantOptions;type='VARIANT'}
        else if(definition.type==='BOOLEAN'&&input.includeBoolean){options=[true,false];type='BOOLEAN'}
        else continue;
        if(!Array.isArray(options)||options.length===0||options.length>MAX_OPTIONS||new Set(options.map(String)).size!==options.length||options.some(value=>type==='VARIANT'?(typeof value!=='string'||!value||value.length>MAX_OPTION||unsafe.test(value)):typeof value!=='boolean'))return refusal('Component Set property options are malformed or excessive.');
        total*=options.length;
        if(total>MAX_COMBINATIONS)return refusal('Component combinations exceed the bounded limit of '+MAX_COMBINATIONS+'.');
        properties.push({name,type,options:[...options]});
      }
      if(properties.length===0)return refusal('No Variant or included Boolean properties found.');
      defaultVariant=componentSet.defaultVariant;
      if(!defaultVariant||defaultVariant.type!=='COMPONENT'||!setChildren.includes(defaultVariant.id)||typeof defaultVariant.createInstance!=='function')return refusal('Component Set has no valid default Variant.');
      let instanceW=0,instanceH=0;
      for(const child of componentSet.children){if(child.type==='COMPONENT'){if(!finite(child.width)||!finite(child.height)||child.width<=0||child.height<=0)return refusal('Component Set Variant geometry is invalid.');instanceW=Math.max(instanceW,child.width);instanceH=Math.max(instanceH,child.height)}}
      const rows=properties.slice(0,-1).reduce((count,property)=>count*property.options.length,1);
      const cols=properties[properties.length-1].options.length;
      const combinations=[[]];
      for(const property of properties){const prior=combinations.splice(0);for(const combo of prior)for(const option of property.options)combinations.push([...combo,option])}
      if(combinations.length!==total)return refusal('Component combinations could not be bounded exactly.');
      for(const combo of combinations){
        const name=componentSet.name+'/'+combo.map(String).join('/');
        const rowLabel=combo.slice(0,-1).map(String).join(' / ');
        if(name.length>MAX_NAME||unsafe.test(name)||rowLabel.length>MAX_NAME||unsafe.test(rowLabel))return refusal('Generated Component names or labels exceed the bounded text contract.');
      }
      const labelCount=input.labels?cols+(properties.length>1?rows:0):0;
      if(pageIds.length+total+labelCount>MAX_CHILDREN)return refusal('Generated combinations would exceed the bounded current-page child count.');
      const analysis={componentSetId:componentSet.id,componentSetName:componentSet.name,properties,totalCombinations:total,rows,cols,instanceSize:{width:instanceW,height:instanceH}};
      if(input.dryRun)return bounded({schemaVersion:1,status:'analyzed',analysis});
      if(input.labels){await figma.loadFontAsync({family:'Inter',style:'Regular'});await figma.loadFontAsync({family:'Inter',style:'Medium'})}
      beforePageIds=[...pageIds];
      beforeSelectionIds=page.selection.map(node=>node&&node.id);
      if(beforeSelectionIds.length>MAX_CHILDREN||beforeSelectionIds.some(id=>typeof id!=='string')||new Set(beforeSelectionIds).size!==beforeSelectionIds.length)return refusal('Current selection identities are invalid or excessive.');
      let startX=0;
      for(const node of page.children){if(!finite(node.x)||!finite(node.width))throw new Error('Current page geometry is invalid.');startX=Math.max(startX,node.x+node.width)}
      startX+=200;
      const startY=100,labelOffset=input.labels?120:0,headerOffset=input.labels?40:0;
      if(!finite(startX)||!finite(startX+labelOffset+(cols-1)*(instanceW+input.gap))||!finite(startY+headerOffset+(rows-1)*(instanceH+input.gap)))return refusal('Generated combination placement exceeds the bounded geometry contract.');
      const finalIds=[],components=[],labels=[];
      const own=(node)=>{if(!node||typeof node.id!=='string'||typeof node.remove!=='function')throw new Error('Created node is not attributable.');if(!ownedIds.includes(node.id)){ownedIds.push(node.id);if(ownedIds.length>MAX_OWNED)throw new Error('Generated node ownership exceeded its bound.')}return node};
      const addLabel=(characters,fontStyle,fontSize,x,y,centered)=>{attempted++;const label=own(figma.createText());label.fontName={family:'Inter',style:fontStyle};label.characters=String(characters);label.fontSize=fontSize;label.fills=[{type:'SOLID',color:{r:fontSize===14?.6:.5,g:fontSize===14?.6:.5,b:fontSize===14?.6:.5}}];label.x=centered?x-label.width/2:x;label.y=y-label.height/2;labels.push({id:label.id,characters:label.characters,x:label.x,y:label.y});finalIds.push(label.id)};
      if(input.labels){const column=properties[properties.length-1];for(let index=0;index<cols;index++)addLabel(column.options[index],'Medium',14,startX+labelOffset+index*(instanceW+input.gap)+instanceW/2,startY+7,true)}
      for(let index=0;index<combinations.length;index++){
        const combo=combinations[index],row=Math.floor(index/cols),col=index%cols;
        if(input.labels&&col===0&&properties.length>1)addLabel(combo.slice(0,-1).join(' / '),'Regular',12,startX,startY+headerOffset+row*(instanceH+input.gap)+instanceH/2,false);
        attempted++;
        const instance=own(defaultVariant.createInstance());
        if(instance.type!=='INSTANCE'||typeof instance.setProperties!=='function'||typeof instance.detachInstance!=='function')throw new Error('Default Variant did not create a compatible Instance.');
        const values={};
        for(let propertyIndex=0;propertyIndex<properties.length;propertyIndex++)Object.defineProperty(values,properties[propertyIndex].name,{value:combo[propertyIndex],enumerable:true,configurable:true,writable:true});
        instance.setProperties(values);
        const applied=await figma.getNodeByIdAsync(instance.id);
        const appliedProperties=applied&&applied.type==='INSTANCE'?applied.componentProperties:null;
        if(!appliedProperties||typeof appliedProperties!=='object'||Array.isArray(appliedProperties))throw new Error('Generated Instance properties could not be freshly verified.');
        for(let propertyIndex=0;propertyIndex<properties.length;propertyIndex++){
          const property=properties[propertyIndex],entry=ownProperty(appliedProperties,property.name)?appliedProperties[property.name]:null;
          if(!entry||entry.type!==property.type||!Object.is(entry.value,combo[propertyIndex]))throw new Error('Generated Instance property postcondition failed.');
        }
        const detached=own(applied.detachInstance());
        const component=own(figma.createComponentFromNode(detached));
        const expectedName=componentSet.name+'/'+combo.map(String).join('/');
        component.name=expectedName;
        component.x=startX+labelOffset+col*(instanceW+input.gap);
        component.y=startY+headerOffset+row*(instanceH+input.gap);
        components.push({id:component.id,name:component.name,x:component.x,y:component.y});
        finalIds.push(component.id);
      }
      const freshPage=await figma.getNodeByIdAsync(page.id),freshIds=ids(freshPage,'Fresh current page');
      if(finalIds.length!==total+labels.length||labels.length!==labelCount||new Set(finalIds).size!==finalIds.length)throw new Error('Generated combination identities are incomplete.');
      for(const expected of components){const node=await figma.getNodeByIdAsync(expected.id);if(!node||node.parent?.id!==page.id||node.type!=='COMPONENT'||node.name!==expected.name||node.x!==expected.x||node.y!==expected.y||!finite(node.width)||node.width<=0||!finite(node.height)||node.height<=0)throw new Error('Generated Component verification failed.')}
      for(const expected of labels){const node=await figma.getNodeByIdAsync(expected.id);if(!node||node.parent?.id!==page.id||node.type!=='TEXT'||node.characters!==expected.characters||node.x!==expected.x||node.y!==expected.y)throw new Error('Generated label verification failed.')}
      const expectedPage=[...beforePageIds,...finalIds];
      if(!same(freshIds,expectedPage))throw new Error('Current page membership changed unexpectedly.');
      const warnings=[],selected=[];
      for(const id of finalIds){const node=await figma.getNodeByIdAsync(id);if(node)selected.push(node)}
      try{page.selection=selected;if(!same(page.selection.map(node=>node&&node.id),finalIds))warnings.push('Generated nodes were verified, but selection could not be updated exactly.')}catch{warnings.push('Generated nodes were verified, but selection could not be updated.')}
      try{figma.viewport.scrollAndZoomIntoView(selected)}catch{warnings.push('Generated nodes were verified, but viewport focus could not be updated.')}
      delete globalThis.__invCache;
      return bounded({schemaVersion:1,status:'created',analysis,count:components.length,labelCount:labels.length,gridSize:rows+'x'+cols,components:components.slice(0,3),warnings,attempted,residue:[]});
    }catch(error){
      const failure=clean(error&&error.message?error.message:String(error),1024);
      if(attempted===0)return refusal(failure);
      for(let index=ownedIds.length-1;index>=0;index--){try{const node=await figma.getNodeByIdAsync(ownedIds[index]);if(node&&typeof node.remove==='function')node.remove()}catch{}}
      try{const restored=[];for(const id of beforeSelectionIds){const node=await figma.getNodeByIdAsync(id);if(node&&node.parent?.id===page.id)restored.push(node)}page.selection=restored}catch{}
      try{
        const fresh=await figma.getNodeByIdAsync(page.id),restoredIds=ids(fresh,'Restored current page'),residueIds=[];
        for(const id of new Set(ownedIds)){let attached=false;try{const node=await figma.getNodeByIdAsync(id);attached=Boolean(node&&node.parent)}catch{}if(attached||restoredIds.includes(id))residueIds.push(clean(id))}
        const pageChanged=!same(restoredIds,beforePageIds),selectionChanged=!same(page.selection.map(node=>node&&node.id),beforeSelectionIds),restored=residueIds.length===0&&!pageChanged&&!selectionChanged;
        if(restored)delete globalThis.__invCache;
        return bounded({schemaVersion:1,status:'failed',outcome:restored?'rolled-back':'partial-residue',attempted,restored:restored?attempted:0,residue:{residueIds,pageChanged,selectionChanged},failure});
      }catch{return bounded({schemaVersion:1,status:'failed',outcome:'verification-unavailable',attempted,restored:0,residue:{residueIds:[],pageChanged:false,selectionChanged:false},failure})}
    }
  })()`;
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

const validString = (value, maximum = 512, empty = false) =>
  typeof value === "string" &&
  value.length <= maximum &&
  (empty || value.length > 0) &&
  !UNSAFE_TEXT.test(value);
const validId = (value) =>
  validString(value, 512) && NODE_REFERENCE_PATTERN.test(value);
const validGeometry = (value, positive = false) =>
  Number.isFinite(value) &&
  Math.abs(value) <= MAX_COMPONENT_COMBINATIONS_GEOMETRY &&
  (!positive || value > 0);

const validAnalysis = (value) => {
  if (
    !exactKeys(value, [
      "componentSetId",
      "componentSetName",
      "properties",
      "totalCombinations",
      "rows",
      "cols",
      "instanceSize",
    ]) ||
    !validId(value.componentSetId) ||
    !validString(
      value.componentSetName,
      MAX_COMPONENT_COMBINATIONS_NAME_CODE_UNITS
    ) ||
    !Number.isSafeInteger(value.totalCombinations) ||
    value.totalCombinations < 1 ||
    value.totalCombinations > MAX_COMPONENT_COMBINATIONS ||
    !Number.isSafeInteger(value.rows) ||
    value.rows < 1 ||
    !Number.isSafeInteger(value.cols) ||
    value.cols < 1 ||
    value.rows * value.cols !== value.totalCombinations ||
    !Array.isArray(value.properties) ||
    value.properties.length < 1 ||
    value.properties.length > MAX_COMPONENT_COMBINATIONS_PROPERTIES ||
    !exactKeys(value.instanceSize, ["width", "height"]) ||
    !validGeometry(value.instanceSize.width, true) ||
    !validGeometry(value.instanceSize.height, true)
  )
    return false;
  const names = new Set();
  let total = 1;
  for (const property of value.properties) {
    if (
      !exactKeys(property, ["name", "type", "options"]) ||
      !validString(property.name, MAX_COMPONENT_COMBINATIONS_NAME_CODE_UNITS) ||
      names.has(property.name) ||
      !["VARIANT", "BOOLEAN"].includes(property.type) ||
      !Array.isArray(property.options) ||
      property.options.length < 1 ||
      property.options.length > MAX_COMPONENT_COMBINATIONS_OPTIONS ||
      new Set(property.options.map(String)).size !== property.options.length ||
      property.options.some((option) =>
        property.type === "VARIANT"
          ? !validString(option, MAX_COMPONENT_COMBINATIONS_OPTION_CODE_UNITS)
          : typeof option !== "boolean"
      ) ||
      (property.type === "BOOLEAN" &&
        (property.options.length !== 2 ||
          property.options[0] !== true ||
          property.options[1] !== false))
    )
      return false;
    names.add(property.name);
    total *= property.options.length;
  }
  const expectedRows = value.properties
    .slice(0, -1)
    .reduce((count, property) => count * property.options.length, 1);
  const expectedCols =
    value.properties[value.properties.length - 1].options.length;
  if (
    total !== value.totalCombinations ||
    value.rows !== expectedRows ||
    value.cols !== expectedCols
  )
    return false;
  return combinationsFor(value.properties).every((combination) => {
    const componentName = `${value.componentSetName}/${combination
      .map(String)
      .join("/")}`;
    const rowLabel = combination.slice(0, -1).map(String).join(" / ");
    return (
      validString(componentName, MAX_COMPONENT_COMBINATIONS_NAME_CODE_UNITS) &&
      validString(rowLabel, MAX_COMPONENT_COMBINATIONS_NAME_CODE_UNITS, true)
    );
  });
};

function combinationsFor(properties) {
  const combinations = [[]];
  for (const property of properties) {
    const prior = combinations.splice(0);
    for (const combination of prior) {
      for (const option of property.options) {
        combinations.push([...combination, option]);
      }
    }
  }
  return combinations;
}

function validRefusal(value) {
  return (
    exactKeys(value, [
      "schemaVersion",
      "status",
      "outcome",
      "attempted",
      "failure",
    ]) &&
    value.schemaVersion === 1 &&
    value.status === "refused" &&
    value.outcome === "no-mutation" &&
    value.attempted === 0 &&
    validString(value.failure, 1_024)
  );
}

function validFailure(value) {
  return (
    exactKeys(value, [
      "schemaVersion",
      "status",
      "outcome",
      "attempted",
      "restored",
      "residue",
      "failure",
    ]) &&
    value.schemaVersion === 1 &&
    value.status === "failed" &&
    ["rolled-back", "partial-residue", "verification-unavailable"].includes(
      value.outcome
    ) &&
    Number.isSafeInteger(value.attempted) &&
    value.attempted >= 1 &&
    value.attempted <= MAX_ATTEMPTS &&
    Number.isSafeInteger(value.restored) &&
    value.restored >= 0 &&
    value.restored <= value.attempted &&
    exactKeys(value.residue, [
      "residueIds",
      "pageChanged",
      "selectionChanged",
    ]) &&
    Array.isArray(value.residue.residueIds) &&
    value.residue.residueIds.length <= MAX_OWNED_IDS &&
    value.residue.residueIds.every(validId) &&
    new Set(value.residue.residueIds).size ===
      value.residue.residueIds.length &&
    typeof value.residue.pageChanged === "boolean" &&
    typeof value.residue.selectionChanged === "boolean" &&
    validString(value.failure, 1_024) &&
    (value.outcome !== "rolled-back" ||
      (value.restored === value.attempted &&
        value.residue.residueIds.length === 0 &&
        !value.residue.pageChanged &&
        !value.residue.selectionChanged)) &&
    (value.outcome !== "partial-residue" ||
      (value.restored === 0 &&
        (value.residue.residueIds.length > 0 ||
          value.residue.pageChanged ||
          value.residue.selectionChanged))) &&
    (value.outcome !== "verification-unavailable" ||
      (value.restored === 0 &&
        value.residue.residueIds.length === 0 &&
        !value.residue.pageChanged &&
        !value.residue.selectionChanged))
  );
}

function validSuccess(value, input) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "status",
      "analysis",
      "count",
      "labelCount",
      "gridSize",
      "components",
      "warnings",
      "attempted",
      "residue",
    ]) ||
    value.schemaVersion !== 1 ||
    value.status !== "created" ||
    !validAnalysis(value.analysis) ||
    value.count !== value.analysis.totalCombinations ||
    value.gridSize !== `${value.analysis.rows}x${value.analysis.cols}` ||
    !Number.isSafeInteger(value.labelCount) ||
    value.labelCount !==
      (input.labels
        ? value.analysis.cols +
          (value.analysis.properties.length > 1 ? value.analysis.rows : 0)
        : 0) ||
    value.attempted !== value.count + value.labelCount ||
    !Array.isArray(value.residue) ||
    value.residue.length !== 0 ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 2 ||
    value.warnings.some((warning) => !WARNINGS.has(warning)) ||
    !Array.isArray(value.components) ||
    value.components.length !== Math.min(3, value.count)
  )
    return false;
  const combinations = combinationsFor(value.analysis.properties);
  const ids = new Set();
  const first = value.components[0];
  for (let index = 0; index < value.components.length; index++) {
    const component = value.components[index];
    const row = Math.floor(index / value.analysis.cols);
    const col = index % value.analysis.cols;
    const expectedName = `${value.analysis.componentSetName}/${combinations[
      index
    ]
      .map(String)
      .join("/")}`;
    if (
      !exactKeys(component, ["id", "name", "x", "y"]) ||
      !validId(component.id) ||
      ids.has(component.id) ||
      component.name !== expectedName ||
      !validString(
        component.name,
        MAX_COMPONENT_COMBINATIONS_NAME_CODE_UNITS
      ) ||
      !validGeometry(component.x) ||
      !validGeometry(component.y) ||
      component.x !==
        first.x + col * (value.analysis.instanceSize.width + input.gap) ||
      component.y !==
        first.y + row * (value.analysis.instanceSize.height + input.gap)
    )
      return false;
    ids.add(component.id);
  }
  return true;
}

function pluginError(message) {
  /** @type {Error & {kind?:string,phase?:string,outcome?:string}} */
  const error = new Error(message);
  error.kind = "plugin-result";
  error.phase = "plugin-response";
  error.outcome = "unknown-after-dispatch";
  return error;
}

function mutationError(message, outcome, report) {
  /** @type {Error & {kind?:string,phase?:string,outcome?:string,dispatchState?:string,mutationOutcome?:unknown,mutationReport?:unknown}} */
  const error = new Error(message);
  error.kind = "execution";
  error.phase = "plugin-execution";
  error.outcome = "unknown-after-dispatch";
  error.dispatchState = "failed";
  error.mutationOutcome = outcome;
  error.mutationReport = report;
  return error;
}

export async function executeComponentCombinations(request, adapters = {}) {
  if (typeof adapters.evaluate !== "function") {
    throw new TypeError(
      "Component Combinations requires a Figma evaluate adapter."
    );
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(componentCombinationsCode(input));
  if (
    typeof serialized !== "string" ||
    serialized.length > MAX_COMPONENT_COMBINATIONS_RESULT_CODE_UNITS
  ) {
    throw pluginError(
      "Component Combinations returned an invalid bounded result."
    );
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw pluginError("Component Combinations returned invalid JSON.");
  }
  if (payload?.status === "refused") {
    if (!validRefusal(payload)) {
      throw pluginError("Component Combinations returned an invalid refusal.");
    }
    throw mutationError(
      `Component Combinations made no mutation: ${payload.failure}`,
      "no-mutation",
      {
        version: 1,
        outcome: "no-mutation",
        attempted: 0,
        restored: 0,
        residueCount: 0,
      }
    );
  }
  if (payload?.status === "failed") {
    if (!validFailure(payload)) {
      throw pluginError("Component Combinations returned an invalid failure.");
    }
    const residueCount =
      payload.residue.residueIds.length +
      Number(payload.residue.pageChanged) +
      Number(payload.residue.selectionChanged);
    throw mutationError(
      `Component Combinations failed: ${payload.failure}`,
      payload.outcome,
      {
        version: 1,
        outcome: payload.outcome,
        attempted: payload.attempted,
        restored: payload.restored,
        residueCount,
      }
    );
  }
  if (input.dryRun) {
    if (
      !exactKeys(payload, ["schemaVersion", "status", "analysis"]) ||
      payload.schemaVersion !== 1 ||
      payload.status !== "analyzed" ||
      !validAnalysis(payload.analysis)
    ) {
      throw pluginError(
        "Component Combinations returned an invalid dry-run result."
      );
    }
    const properties = payload.analysis.properties
      .map((property) => `  ${property.name}: ${property.options.join(", ")}`)
      .join("\n");
    return {
      stdout:
        `${payload.analysis.totalCombinations} combinations (dry run)` +
        `\nProperties:\n${properties}` +
        `\nWould create ${payload.analysis.totalCombinations} components`,
      stderr: "",
      result: payload,
    };
  }
  if (!validSuccess(payload, input)) {
    throw pluginError(
      "Component Combinations returned an invalid creation result."
    );
  }
  const labelInfo = payload.labelCount
    ? ` with ${payload.labelCount} labels`
    : "";
  const names = payload.components
    .map((component) => component.name)
    .join(", ");
  return {
    stdout: `Created ${payload.count} components in ${payload.gridSize} grid${labelInfo}${names ? `\n  ${names}${payload.count > 3 ? ", ..." : ""}` : ""}`,
    stderr: payload.warnings.join("\n"),
    result: payload,
  };
}

export function componentCombinationsPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError(
      "Component Combinations routing requires a Command Plan."
    );
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? "command-application"
    : "not-component-combinations";
}

export async function executeComponentCombinationsPlan(plan, adapters = {}) {
  if (componentCombinationsPlanRoute(plan) !== "command-application") {
    throw new Error(
      `Command Plan ${plan?.id || "(unknown)"} is not owned by Component Combinations.`
    );
  }
  return executeComponentCombinations(
    parseComponentCombinationsRequest(plan.argv),
    adapters
  );
}

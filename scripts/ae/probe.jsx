var log = new File("C:/Users/schxm/AppData/Local/Temp/aep-web-ae-probe.log");
log.open("w");
log.writeln("started");
try {
  log.writeln("version " + app.version + " build " + app.buildName + " lang " + app.isoLanguage);
  app.newProject();
  var comp = app.project.items.addComp("probe", 64, 48, 1, 1, 24);
  log.writeln("comp " + comp.name);
  var solid = comp.layers.addSolid([1, 0.5, 0], "s", 64, 48, 1);
  log.writeln("solid props " + solid.numProperties);
  for (var i = 1; i <= solid.numProperties; i++) log.writeln("  " + solid.property(i).matchName);
  var parade = solid.property("ADBE Effect Parade");
  log.writeln("parade null? " + (parade === null));
  log.writeln("canAdd " + parade.canAddProperty("ADBE Fill"));
  var fx = parade.addProperty("ADBE Fill");
  log.writeln("fx null? " + (fx === null));
  log.writeln("added " + fx.matchName + " " + fx.name + " params " + fx.numProperties);
  log.writeln("effects " + app.effects.length);
  var out = new File("C:/Users/schxm/AppData/Local/Temp/aep-web-ae-probe.aep");
  app.project.save(out);
  log.writeln("saved " + out.fsName + " " + out.exists);
} catch (e) {
  log.writeln("error " + e.toString() + " line " + e.line);
}
log.close();

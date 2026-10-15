const KEY = "cur1e.shared.v1";

function create(){
    const entries = [];
    let built = false;

    function header(name, text){
        return extend(SettingsMenuDialog.SettingsTable.Setting, name, {
            add(table){
                table.add(text).color(Color.gray).pad(10).padBottom(4);
                table.row();
                table.image().color(Color.gray).fillX().height(3).pad(6).padTop(0).padBottom(10);
                table.row();
            }
        });
    }

    function title(e){
        const m = Vars.mods.getMod(e.mod);
        const fallback = m == null ? e.mod : m.meta.displayName;
        return e.title ? Core.bundle.get(e.title, fallback) : fallback;
    }

    function build(){
        if(built || entries.length == 0) return;
        built = true;
        const single = entries.length == 1;
        const icon = single && entries[0].icon ? Icon[entries[0].icon] : Icon.box;
        Vars.ui.settings.addCategory(single ? title(entries[0]) : "Cur1e Mods", icon, cons(t => {
            entries.forEach(e => {
                try{
                    if(!single) t.pref(header("cur1e-header-" + e.mod, title(e)));
                    e.build(t);
                }catch(err){
                    Log.err("[" + e.mod + "] settings: " + err);
                }
            });
        }));
    }

    Events.on(ClientLoadEvent, () => build());

    return {
        version: 1,
        settings(e){
            if(built){
                Log.err("[" + e.mod + "] settings registered after ClientLoadEvent, ignored");
                return;
            }
            entries.push({mod: e.mod, title: e.title, icon: e.icon, build: e.build});
        },
        header: header
    };
}

const props = java.lang.System.getProperties();
let shared = props.get(KEY);
if(shared == null){
    shared = create();
    props.put(KEY, shared);
}

module.exports = {
    version: shared.version,
    settings: e => shared.settings(e),
    header: (name, text) => shared.header(name, text)
};

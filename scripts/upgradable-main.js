console.log('upgradable-items | Loaded!');

Hooks.once("init", () => {
    loadTemplates(["modules/upgradable-items/templates/upitab-template.hbs"]);
    Handlebars.registerHelper("ifEquals", function (a, b, options) {
        return a === b ? options.fn(this) : options.inverse(this);
    });

    console.log("Upgrade Active language:", game.i18n.lang);
});

Hooks.on("getSceneControlButtons", controls => {
    const userToken = canvas.tokens?.controlled[0];
    if (!userToken) return;  // Guard clause: no token selected

    const flagValue = userToken.actor?.getFlag("upgradeable-items", "selectedRunes");
    if (!flagValue) return;

    // Now proceed safely
});

Hooks.on("dnd5e.rollDamage", async (item, config, damageRoll) => {
    if (!item?.actor) return;

    const runeData = item.flags["upgradable-items"] ?? {};
    const { enhanceLvl = "0", cluster1 = "0" } = runeData;

    console.log("Upgradable Selected Runes:", runeData);

    const itemType = item.type;
    const weaponSubtype = item.system.weaponType ?? "";
    console.log("Rolldamage Hook");
    if (itemType === "weapon") {
        if (itemType === "weapon" && weaponSubtype.includes("R")) {
            await applyRangedEnhancements(item.actor, item, runeData);

        } else {
            await applyMeleeEnhancements(item.actor, item, runeData);
        }
    }
});

async function applyRangedEnhancements(actor, item, upgrades) {
    const level = upgrades.enhanceLvl;
    const cluster = upgrades.cluster1;
    console.log("Upgrade In Ranged Enhancements");
    if (level == 0) { return; }
    const damageDieMap = {
        "1": "1d4",    // Runed
        "2": "1d6",    // Infused
        "3": "1d8"     // Awakened
    };

    const clusterDamageTypeMap = {
        "1": "fire",
        "2": "acid",
        "3": "cold"
    };

    const damageDie = damageDieMap[level] ?? "1d4";
    const damageType = clusterDamageTypeMap[cluster] ?? "force";
    const formula = `${damageDie}`;

    // Roll the damage
    const roll = new Roll(formula);
    await roll.evaluate({ async: true });

    // Create chat message using 5e-style formatting
    await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: `${item.name} unleashes a ${damageType} burst from its enhancement!`,
        rollMode: game.settings.get("core", "rollMode")
    });

    // Return useful metadata
    return {
        formula,
        type: damageType,
        total: roll.total,
        text: `Ranged ${damageType} enhancement dealt ${roll.total} (${damageDie})`
    };
}

async function applyMeleeEnhancements(actor, item, upgrades) {
    const level = upgrades.enhanceLvl;
    const cluster = upgrades.cluster1;
    console.log("Upgrade In Melee Enhancements:", upgrades);
    if (level == 0) { return; }
    const damageDieMap = {
        "1": "1d4",    // Runed
        "2": "1d6",    // Infused
        "3": "1d8"     // Awakened
    };

    const clusterDamageTypeMap = {
        "1": "fire",
        "2": "acid",
        "3": "cold"
    };

    const damageDie = damageDieMap[level] ?? "1d4";
    const damageType = clusterDamageTypeMap[cluster] ?? "force";
    const formula = `${damageDie}`;

    // Roll the damage
    const roll = new Roll(formula);
    await roll.evaluate({ async: true });

    // Create chat message using 5e-style formatting
    await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: `${item.name} unleashes a ${damageType} burst from its enhancement!`,
        rollMode: game.settings.get("core", "rollMode")
    });

    // Return useful metadata
    return {
        formula,
        type: damageType,
        total: roll.total,
        text: `Ranged ${damageType} enhancement dealt ${roll.total} (${damageDie})`
    };
}

Hooks.on("renderItemSheet5e", async (app, html, data) => {
    try {
        

        const locale = game.i18n.translations[game.i18n.lang]?.["upgradable-items"]?.SOLVARIS?.Labels || {};

        const runeTiers = {};
        const runeTooltips = {};

        for (let tier = 1; tier <= 3; tier++) {
            const tierKey = `Rune${tier}`;
            const runeSet = locale?.[tierKey];

            if (!runeSet) continue;

            const entries = Object.entries(runeSet)
                .filter(([_, v]) => typeof v === "object");

            //runeTiers[`potency${tier}`] = entries.map(([runeKey, rune]) => {
            //    const labelKey = `upgradable-items.SOLVARIS.Labels.${tierKey}.${runeKey}.Label`;
            //    const hintKey = `upgradable-items.SOLVARIS.Labels.${tierKey}.${runeKey}.Hint`;

            //    const label = game.i18n.localize(labelKey);
            //    const hint = game.i18n.localize(hintKey);

            //    runeTooltips[label] = hint;
            //    return label;
            //});
        }
        // Build enhancement levels list from SOLVARIS.EnhancementLevels
        const enhanceLvlObj = game.i18n.translations?.["upgradable-items"]?.["SOLVARIS"]?.["EnhancementLevels"] ?? {};
        const enhanceLvls = Object.entries(enhanceLvlObj).map(([id, label]) => ({ id, label }));

        // Build cluster list from SOLVARIS.Cluster
        const clusterObj = game.i18n.translations?.["upgradable-items"]?.["SOLVARIS"]?.["Cluster"] ?? {};
        const runeClusters = Object.entries(clusterObj).map(([id, label]) => ({ id, label }));

        const itemFlags = foundry.utils.getProperty(app.object, "flags.upgradable-items") || {};

        const detailsTab = html.find('.tab.details[data-tab="details"]');
        if (!detailsTab.length) {
            console.warn("Upitab: Could not find .tab.details");
            return;
        }

        const sheetBody = detailsTab.children().first();
        if (!sheetBody.length) {
            console.warn("Upitab: Could not resolve sheet body via structural traversal");
            return;
        }

        const fieldsets = sheetBody.find('fieldset:not(.upitab-extension)');
        const target = fieldsets.length ? fieldsets.last() : sheetBody;
        const defaultEnhancementLvl = { id: "", label: "— Select an Enhancement —" };
        const defaultCluster = { id: "", label: "— Select a Cluster —" };

        const defaultEnhancementLvlValue = "0";
        const defaultClusterValue = "0";

        const selectedRunes = {
            enhanceLvl: itemFlags.enhanceLvl ?? "0",
            cluster1: itemFlags.cluster1 ?? "0",
            cluster2: itemFlags.cluster2 ?? "0",
            cluster3: itemFlags.cluster3 ?? "0"
        };

        const htmlload = await renderTemplate("modules/upgradable-items/templates/upitab-template.hbs", {
            ...data,
            fieldIdPrefix: `upitab-${app.id}-`,
            enhanceLvls,
            runeTooltips,
            runeClusters,
            selectedRunes
        });

        const injectedHtml = $(htmlload); 

        injectedHtml.find('[data-property]').on("change", async (event) => {
            const key = event.currentTarget.dataset.property;
            const selectedId = event.currentTarget.value;

            // Retrieve the full label from localization
            const enhanceLvlObj = game.i18n.translations?.["upgradable-items"]?.["SOLVARIS"]?.["EnhancementLevels"] ?? {};
            const enhncelabel = enhanceLvlObj[selectedId] ?? "";
            const clusterObj = game.i18n.translations?.["upgradable-items"]?.["SOLVARIS"]?.["Cluster"] ?? {};
            const label = clusterObj[selectedId] ?? "";

            // If nothing is selected, set a stub object
            //const value = selectedId
            //    ? { id: selectedId, label }
            //    : { id: "", label: "— Select a Cluster —" };

            try {
                await app.object.setFlag("upgradable-items", key, selectedId);
            } catch (err) {
                console.error(`Failed to set ${key}:`, err);
            }
        });


        target.after(injectedHtml);
    } catch (error) {
        console.error("Upitab Injection Error:", error);
    }
});
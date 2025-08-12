# Upgradable Item Slots
A Dnd5e **(Still WIP)** module for the Foundry VTT system that is an attempt at streamlining the item upgrade process for your players and the yourself as the DM/GM. What this offers is a way to take an item, modify "slots" and give items perks and features rather than always having to create and item and manually adjust things which take time. The ideal is inspired by dwarven runes being slotted into items and those runes giving perks, boons, and banes accordingly.

## History/Reasoning
My players regularly asked about upgrading their existing items, crafting new items, etc. I spent a fair amount of time coming up with quests and concepts of developing special homebrewed items and most of the time I had to spend time in between sessions working through foundry's different features, integrating with other modules, creating macros, etc. This is a way of allowing the DM to have a framework of upgrades to quickly "slot" in the features as you wish. I've separated them into "Clusters" which indicate the environment the crafting or slotting would occur in to build an effect accordingly. This is thematic and to give the players more options (or limit them) according to the quests/etc which the DM/GM wishes to develop for this effort. The module also includes 2 additional options to add a spell and feature/feat to the actor which weilds it. These work independant of the clusters and access your compendium to generate the lists. Once selected, the spell or feature/feat is added to the actor and shows up in the character sheet. Most (if not nearly all) of these settings check that the item is equipped and/or if attunement is required. Once all these requirements are satisfied, the different settings activate/display. 

## Framework
Based on the item type (currently only shooting to support weapons and armor), the item will include 4 new rune/cluster slots within the Details tab. Describing those first: 

<img width="500" height="1018" alt="image" src="https://github.com/ElemorSeru/upgradable-items/blob/main/images/itemSlotView.png" />

These indicate "Tiers" of upgrades. Consider them like slotting runes or magical items into the item. The Enhancment Level and Clusters work in conjunction, however not all Clusters use the Enhancment level (described below).

## Current (Goal) Mechanics
### 📈 Enhancement Level (Name/Armor/Weapon)
| Name | AC Gain | Weapon Die Roll | 
| --- | --- | --- |
| None | +0 | 0 |
| Runed | +1 | 1d4 | 
| Infused | +2 | 1d6 | 
| Awakened | +3 | 1d8 | 

### Terrain Themed Clusters
| Cluster | Environments | Elemental Themes | 
| --- | --- | --- |
| I | Coastal, Grassland, Savannah, Urban/City | Radiant, Thunder, Lightning | 
| II | Hills, Underground, Swamp, Desert, Forest | Acid, Necrotic, Earth | 
| III | Arctic, Feywild, Mountains, Volcanos, Blightshore | Fire, Cold, Volatile Magic | 


### 🔨 Tier 1 Cluster Effects
#### 🌀 Cluster I
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | Radiant or thunder damage |
| Armor | Attacker takes lightning damage on melee hit (once/turn) |
| Ranged Ammo | Sonic damage + tracer whistle (helps allies target) |

#### 🌿 Cluster II
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | Acid or necrotic damage |
| Armor | While prone, regain HP equal to enhancement die |
| Ranged Ammo | Poison trace, delayed damage on next turn |

#### 🔥 Cluster III
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | Fire or cold damage |
| Armor | Below half HP, regain HP equal to enhancement die |
| Ranged Ammo | Reduces target’s movement by 5 ft per damage die |


### 🔨 Tier 2 Cluster Effects
Tactical movement and terrain manipulation
Triggered on crits or once per short rest

#### 🌀 Cluster I
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | Crit + push target 10 ft (Str save DC 13) |
| Armor | Move through allies without provoking (1/rest) |
| Ranged Ammo | Creates light cover for adjacent ally via debris |
  
#### 🌿 Cluster II
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | Crit + pull 5 ft or stagger footing |
| Armor | Ignore terrain penalties once/turn |
| Ranged Ammo | Prevents Dash action for affected enemy |

#### 🔥 Cluster III
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | Kill + pulse reveals terrain, enemies lose reactions |
| Armor | First melee attacker Con save or lose reaction |
| Ranged Ammo | Reveals illusion/concealed target (1 turn) |


### 🛠️ Tier 3 Cluster Effects
Battlefield synergy, concealment piercing, ally shielding
Must be forged in matching terrain. Usable once per long rest.

#### 🌀 Cluster I
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | Allies gain +2 to hit vs. struck target |
| Armor | Allies within 10 ft get +2 AC briefly |
| Ranged Ammo | Reveals invisible/concealed creatures near impact |

#### 🌿 Cluster II
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | Struck target loses cover benefit |
| Armor | Stationary grants +2 AC (light cover) |
| Ranged Ammo | Creates 5 ft debris wall (half cover for ally) |

#### 🔥 Cluster III
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | Phantom illusion appears adjacent to target |
| Armor | At ≤10 HP, aura imposes disadvantage on ranged attacks |
| Ranged Ammo | Target can’t succeed Stealth until rune damage removed |

## Additional Perks
Spell Enhancement and Feat Enhancment both read from the existing compendiums and list all the items you have access to. Once selected, the Spell or Feat/Feature will be added to the actor. Selecting a different Spell/Feat/Feature or defaulting back to the "Select a X" option will remove it. As mentioned before, these also only apply if the item is equipped and/or if attunement is gained for the item (if attunement is required). Unequipping will remove any added perks and equipping should re-add them. 

Additional perks and Clusters are independant of one another and an alternate method of giving your players Spells/Features quickly and dynamically. You may use both in combination as you wish. 


/**
 * This file is part of Hide Top Bar
 *
 * Copyright 2020 Thomas Vogt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
const [major] = Config.PACKAGE_VERSION.split('.');
const shellVersion = Number.parseInt(major);

import * as Convenience from './convenience.js';
import * as Intellihide from './intellihide.js';
import * as DesktopIconsIntegration from './desktopIconsIntegration.js';
const DEBUG = Convenience.DEBUG;

const MessageTray = Main.messageTray;
const PanelBox = Main.layoutManager.panelBox;
const ShellActionMode = (
    Shell.ActionMode ? Shell.ActionMode : Shell.KeyBindingMode
);
const _searchEntryBin = Main.overview._overview._controls._searchEntryBin;
const DASH_TO_DOCK_ACTOR_NAME = 'dashtodockContainer';

export class PanelVisibilityManager {

    constructor(settings, monitorIndex) {
        this._monitorIndex = monitorIndex;
        this._base_y = PanelBox.y;
        this._settings = settings;
        this._preventHide = false;
        this._showInOverview = true;
        this._intellihideBlock = false;
        this._staticBox = new Clutter.ActorBox();
        this._animationActive = false;
        this._shortcutTimeout = null;
        this._unredirectDisabled = false;
        this._panelVisible = false;
        this._dashToDockActors = new Map();
        this._dashToDockGuardIds = new Map();
        this._dashToDockRetryId = 0;

        this._desktopIconsUsableArea = (
            new DesktopIconsIntegration.DesktopIconsUsableAreaClass()
        );
        Main.layoutManager.removeChrome(PanelBox);
        Main.layoutManager.addChrome(PanelBox, {
            affectsStruts: false,
            trackFullscreen: true
        });

        // We lost the original notification's position because of
        // PanelBox->affectsStruts = false and now it appears beneath the
        // top bar, fix it
        this._oldEase = MessageTray._bannerBin.ease;
        MessageTray._bannerBin.ease = (
            function(params) {
                if (params.hasOwnProperty("y") && PanelBox.y >= 0) {
                    params.y += PanelBox.height;
                }
                this._oldEase.apply(MessageTray._bannerBin, arguments);
            }
        ).bind(this);

        this._cursorTracker = (
            (typeof global.backend?.get_cursor_tracker === "function")
            ? global.backend.get_cursor_tracker()
            : Meta.CursorTracker.get_for_display(global.display)  // GNOME Shell 45-47
        );
        this._pointerListener = null;

        // Load settings
        this._bindSettingsChanges();
        this._updateSettingsMouseSensitive();
        this._updateSettingsShowInOverview();
        this._intellihide = new Intellihide.Intellihide(
            this._settings, this._monitorIndex,
        );

        this._updateHotCorner(false);
        this._updateStaticBox();
        this._refreshDashToDockActors();
        // Wait until the panel has an allocation: after login this can take
        // a second or two, and on unlock a relayout can still be queued.
        // notify::allocation is not enough, it only fires if the box changes.
        this._bindTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 100, () => {
                if (!PanelBox.has_allocation())
                    return GLib.SOURCE_CONTINUE;
                this._bindTimeoutId = 0;
                this._bindUIChanges();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    hide(animationTime, trigger) {
        DEBUG("hide(" + trigger + ")");
        if(this._preventHide) return;

        let anchor_y = PanelBox.get_pivot_point()[1],
            delta_y = -PanelBox.height;
        if(anchor_y < 0) delta_y = -delta_y;
        let mouse = global.get_pointer();
        if(trigger == "mouse-left" && this._isHovering(...mouse)) return;

        this._stopWatchingPointer();

        if(this._animationActive) {
            PanelBox.remove_all_transitions();
            this._animationActive = false;
        }

        this._animationActive = true;
        PanelBox.ease({
            y: this._base_y + delta_y,
            duration: animationTime * 1000,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._animationActive = false;
                if (!this._settings.get_boolean('keep-round-corners')) {
                    PanelBox.hide();
                }
                this._updateHotCorner(true);
                this._panelVisible = false;
                this._updateUnredirectState();
            }
        });
    }

    // While a shell actor is on screen above a window that covers the whole
    // monitor, that window must not be unredirected (X11) or put on a
    // direct-scanout plane (Wayland): the compositor would skip painting the
    // stage and the actor would stay invisible although it still receives
    // input. GNOME Shell does the same for its own notifications, OSDs and
    // menus. The calls are counted by Mutter, so keep them paired.
    _setUnredirectDisabled(disabled) {
        if (disabled === this._unredirectDisabled) return;
        if (shellVersion >= 48) {
            if (disabled)
                global.compositor.disable_unredirect();
            else
                global.compositor.enable_unredirect();
        } else {
            if (disabled)
                Meta.disable_unredirect_for_display(global.display);
            else
                Meta.enable_unredirect_for_display(global.display);
        }
        this._unredirectDisabled = disabled;
    }

    show(animationTime, trigger) {
        DEBUG("show(" + trigger + ")");
        if(trigger == "mouse-enter"
           && this._settings.get_boolean('mouse-triggers-overview')) {
            Main.overview.show();
        }

        if(this._animationActive) {
            PanelBox.remove_all_transitions();
            this._animationActive = false;
        }

        this._updateHotCorner(false);
        PanelBox.show();
        this._panelVisible = trigger != "destroy";
        this._updateUnredirectState();
        if(trigger == "destroy"
           || (
               trigger == "showing-overview"
               && global.get_pointer()[1] < PanelBox.height
               && this._settings.get_boolean('hot-corner')
              )
          ) {
            PanelBox.y = this._base_y;
        } else {
            this._animationActive = true;
            PanelBox.ease({
                y: this._base_y,
                duration: animationTime * 1000,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this._animationActive = false;
                    this._updateStaticBox();

                    const mouse = global.get_pointer();

                    if(!this._isHovering(...mouse))
                    {
                        // The cursor has already left the panel, so we can
                        // start hiding the panel immediately.
                        this._handleMenus();
                    }
                    else if(!this._pointerListener)
                    {
                        // The cursor is still on the panel. Start watching the
                        // pointer so we know when it leaves the panel.
                        this._pointerListener = this._cursorTracker.connect(
                            'position-invalidated',
                            () => this._handlePointer(...global.get_pointer()),
                        );
                    }
                }
            });
        }
    }

    _updateUnredirectState() {
        this._setUnredirectDisabled(
            this._panelVisible || this._dashToDockNeedsComposition()
        );
    }

    _dashToDockNeedsComposition() {
        for (const dock of this._dashToDockActors.keys()) {
            // Dock state: HIDDEN=0, SHOWING=1, SHOWN=2, HIDING=3.
            // Dash to Dock only inhibits unredirection itself for a monitor
            // with a fullscreen window. A maximized window can cover the
            // monitor as well when this extension removed the panel strut,
            // so keep composition for the whole dock transition here.
            if (dock.visible && dock.dockState > 0)
                return true;
        }
        return false;
    }

    _refreshDashToDockActors() {
        for (const actor of Main.layoutManager.uiGroup.get_children()) {
            if (actor.name === DASH_TO_DOCK_ACTOR_NAME)
                this._trackDashToDockActor(actor);
        }

        if (this._dashToDockActors.size === 0 && !this._dashToDockRetryId) {
            this._dashToDockRetryId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 250, () => {
                    this._dashToDockRetryId = 0;
                    this._refreshDashToDockActors();
                    return this._dashToDockActors.size > 0
                        ? GLib.SOURCE_REMOVE
                        : GLib.SOURCE_CONTINUE;
                }
            );
        }
    }

    _trackDashToDockActor(actor) {
        if (this._dashToDockActors.has(actor) ||
            typeof actor.showDock !== 'function')
            return;

        const stateId = actor.connect(
            'notify::dock-state',
            () => this._handleDashToDockState(actor)
        );
        const visibleId = actor.connect(
            'notify::visible',
            () => this._updateUnredirectState()
        );
        const destroyId = actor.connect('destroy', () => {
            this._untrackDashToDockActor(actor, false);
        });
        this._dashToDockActors.set(actor, {stateId, visibleId, destroyId});
        this._dashToDockGuardIds.set(actor, 0);
        this._updateUnredirectState();
    }

    _untrackDashToDockActor(actor, disconnectDestroy = true) {
        const signals = this._dashToDockActors.get(actor);
        if (!signals)
            return;

        this._dashToDockActors.delete(actor);
        this._updateUnredirectState();
        if (signals.stateId)
            actor.disconnect(signals.stateId);
        if (signals.visibleId)
            actor.disconnect(signals.visibleId);
        if (disconnectDestroy && signals.destroyId)
            actor.disconnect(signals.destroyId);

        const guardId = this._dashToDockGuardIds.get(actor);
        if (guardId)
            GLib.source_remove(guardId);
        this._dashToDockGuardIds.delete(actor);
    }

    _handleDashToDockState(actor) {
        this._updateUnredirectState();

        // Dash to Dock can receive a synthetic leave while its dock slides
        // over a window. If the pointer is still inside the dock's full-size
        // box, ask the dock to stay shown instead of letting it alternate
        // between hidden and shown.
        if (this._dashToDockGuardIds.get(actor) || Main.overview.visible)
            return;

        if (actor.dockState !== 0 && actor.dockState !== 3)
            return;

        const guardId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 100, () => {
                this._dashToDockGuardIds.delete(actor);
                if (!this._dashToDockActors.has(actor))
                    return GLib.SOURCE_REMOVE;

                if ((actor.dockState === 0 || actor.dockState === 3) &&
                    this._isPointerOverDashToDock(actor) &&
                    !Main.overview.visible) {
                    // Preserve Dash to Dock's state machine: HIDDEN -> show,
                    // HIDING -> suppress the pending hide and slide back in.
                    actor.showDock?.();
                }

                return GLib.SOURCE_REMOVE;
            }
        );
        this._dashToDockGuardIds.set(actor, guardId);
    }

    _isPointerOverDashToDock(actor) {
        const box = actor._staticBox;
        if (!box || box.x2 <= box.x1 || box.y2 <= box.y1)
            return false;

        const [x, y] = global.get_pointer();
        const monitor = Main.layoutManager.monitors[actor.monitorIndex];
        const margin = 16;
        if (!monitor ||
            x < monitor.x || x >= monitor.x + monitor.width ||
            y < monitor.y || y >= monitor.y + monitor.height)
            return false;

        // Dash to Dock intentionally extends its hover-sensitive box to the
        // screen edge. The pointer can be on the edge before the dock has
        // finished sliding in, when its allocation is still smaller. Include
        // the full edge band so a real leave is still detected promptly when
        // the pointer moves back into the window.
        if (actor.has_style_class_name('top'))
            return y <= box.y2 + margin;
        if (actor.has_style_class_name('right'))
            return x >= box.x1 - margin;
        if (actor.has_style_class_name('bottom'))
            return y >= box.y1 - margin;
        return x <= box.x2 + margin;
    }

    _isHovering(x, y) {
        return (    y >= this._staticBox.y1 &&
                    y < this._staticBox.y2 &&
                    x >= this._staticBox.x1 &&
                    x < this._staticBox.x2 );
    }

    _stopWatchingPointer() {
        if(this._pointerListener) {
            this._cursorTracker.disconnect(this._pointerListener);
            this._pointerListener = null;
        }
    }

    _handlePointer(x, y) {
        if(!this._animationActive && !this._isHovering(x, y)) {
            this._handleMenus();
        }
    }

    _handleMenus() {
        if(!Main.overview.visible) {
            let blocker = Main.panel.menuManager.activeMenu;
            if(blocker == null) {
                this.hide(
                    this._settings.get_double('animation-time-autohide'),
                    "mouse-left"
                );
            } else {
                this._blockerMenu = blocker;
                this._menuEvent = this._blockerMenu.connect(
                    'open-state-changed',
                    (menu, open) => {
                        if(!open && this._blockerMenu !== null) {
                            this._blockerMenu.disconnect(this._menuEvent);
                            this._menuEvent=null;
                            this._blockerMenu=null;
                            this._handleMenus();
                        }
                    }
                );
            }
        }
    }

    _handleShortcut() {
        let delay_time = this._settings.get_double('shortcut-delay');
        if(this._shortcutTimeout) {
            if(this._shortcutTimeout !== true) {
                GLib.source_remove(this._shortcutTimeout);
            }
            this._shortcutTimeout = null;
            if(delay_time < 0.05
               || this._settings.get_boolean('shortcut-toggles')) {
                this._intellihideBlock = false;
                this._preventHide = false;
                this.hide(
                    this._settings.get_double('animation-time-autohide'),
                    "shortcut"
                );
                return;
            }
        }

        // If setting 'shortcut-toggles' is false, repeatedly pressing the
        // shortcut should prevent the bar from hiding
        if(!this._preventHide || this._intellihideBlock) {
            this._intellihideBlock = true;
            this._preventHide = true;

            if(delay_time > 0.05) {
                let show_time = Math.min(
                  this._settings.get_double('animation-time-autohide'),
                  Math.max(0.1, delay_time/5.0));
                this.show(show_time, "shortcut");

                this._shortcutTimeout = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, delay_time*1200,
                    () => {
                        this._preventHide = false;
                        this._intellihideBlock = false;
                        this._handleMenus();
                        this._shortcutTimeout = null;
                        return false;
                    }
                );
            } else {
                this.show(
                    this._settings.get_double('animation-time-autohide'),
                    "shortcut"
                );
                this._shortcutTimeout = true;
            }
            // Key-focus the "Activities" button
            //  Currently, this is deactivated because we can't make sure that
            //  the panel doesn't hide as long as it has the key focus.
            // Main -> panel -> _leftBox -> (StBin) -> (panel-button)
            // Main.panel._leftBox.first_child.first_child.grab_key_focus();
        }
    }

    _disablePressureBarrier() {
        this._stopWatchingPointer();

        if(this._panelBarrier && this._panelPressure) {
            this._panelPressure.removeBarrier(this._panelBarrier);
            this._panelBarrier.destroy();
            this._panelBarrier = null;
        }
    }

    _initPressureBarrier() {
        this._panelPressure = new Layout.PressureBarrier(
            this._settings.get_int('pressure-threshold'),
            this._settings.get_int('pressure-timeout'),
            ShellActionMode.NORMAL
        );
        this._panelPressure.connect(
            'trigger',
            (barrier) => {
                if (
                    Main.layoutManager.primaryMonitor?.inFullscreen
                    && !this._settings.get_boolean(
                        'mouse-sensitive-fullscreen-window'
                    )
                ) {
                    return;
                }
                this.show(
                    this._settings.get_double('animation-time-autohide'),
                    "mouse-enter"
                );
            }
        );
        let anchor_y = PanelBox.get_pivot_point()[1],
            direction = Meta.BarrierDirection.POSITIVE_Y;
        if(anchor_y < 0) {
            anchor_y -= PanelBox.height;
            direction = Meta.BarrierDirection.NEGATIVE_Y;
        }
        this._panelBarrier = new Meta.Barrier({
            ...(shellVersion === 45  ? { display: global.display } : { backend: global.backend }),
            x1: PanelBox.x,
            x2: PanelBox.x + PanelBox.width,
            y1: this._base_y - anchor_y,
            y2: this._base_y - anchor_y,
            directions: direction
        });
        this._panelPressure.addBarrier(this._panelBarrier);
    }

    _updateStaticBox() {
        DEBUG("_updateStaticBox()");
        let anchor_y = PanelBox.get_pivot_point()[1];
        this._staticBox.init_rect(
            PanelBox.x, PanelBox.y-anchor_y, PanelBox.width, PanelBox.height
        );
        this._intellihide.updateTargetBox(this._staticBox);
        this._desktopIconsUsableArea.resetMargins();
        this._desktopIconsUsableArea.setMargins(-1, PanelBox.height, 0, 0, 0);
    }

    _updateHotCorner(panel_hidden) {
        let HotCorner = null;
        for(let i = 0; i < Main.layoutManager.hotCorners.length; i++){
          let hc = Main.layoutManager.hotCorners[i];
          if(hc){
            HotCorner = hc;
            break;
          }
        }
        if(HotCorner){
          if(!panel_hidden || this._settings.get_boolean('hot-corner')) {
              HotCorner.setBarrierSize(PanelBox.height);
          } else {
              GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, function () {
                  HotCorner.setBarrierSize(0)
              });
          }
        }
    }

    _updateSettingsHotCorner() {
        this.hide(0.1, "hot-corner-setting-changed");
    }

    _updateSettingsMouseSensitive() {
        if(this._settings.get_boolean('mouse-sensitive')) {
            this._disablePressureBarrier();
            this._initPressureBarrier();
        } else this._disablePressureBarrier();
    }

    _updateSettingsShowInOverview() {
        this._showInOverview = this._settings.get_boolean('show-in-overview');
        this._updateSearchEntryPadding();
    }

    _updateSearchEntryPadding() {
        if (!_searchEntryBin) return;
        if (!Main.layoutManager.primaryMonitor) return;
        const scale = Main.layoutManager.primaryMonitor.geometry_scale;
        const offset = PanelBox.height / scale;
        _searchEntryBin.set_style(
            this._showInOverview ? `padding-top: ${offset}px;` : null
        );
    }

    _updateIntellihideStatus() {
        if(this._settings.get_boolean('enable-intellihide')) {
            this._intellihideBlock = false;
            this._preventHide = false;
            this._intellihide.enable();
        } else {
            this._intellihide.disable();
            this._intellihideBlock = true;
            this._preventHide = false;
            this.hide(0, "init");
        }
    }

    _updatePreventHide() {
        if(this._intellihideBlock) return;

        this._preventHide = !this._intellihide.getOverlapStatus();
        let animTime = this._settings.get_double('animation-time-autohide');
        if(this._preventHide) {
            if (this._showInOverview || !Main.overview.visible)
                this.show(animTime, "intellihide");
        } else if(!Main.overview.visible)
            this.hide(animTime, "intellihide");
    }

    _bindUIChanges() {
        this._signalsHandler.add(
            [
                Main.overview,
                'showing',
                () => {
                    if(this._showInOverview) {
                        this.show(
                            this._settings.get_double(
                                'animation-time-overview'
                            ),
                            "showing-overview"
                        );
                    }
                }
            ],
            [
                Main.overview,
                'hiding',
                () => {
                    this.hide(
                        this._settings.get_double('animation-time-overview'),
                        "hiding-overview"
                    );
                }
            ],
            [
                Main.panel,
                'leave-event',
                this._handleMenus.bind(this)
            ],
            [
                PanelBox,
                'notify::anchor-y',
                () => {
                    this._updateStaticBox();
                    this._updateSettingsMouseSensitive();
                }
            ],
            [
                PanelBox,
                'notify::height',
                this._updateSearchEntryPadding.bind(this)
            ],
            [
                Main.layoutManager,
                'monitors-changed',
                () => {
                    this._base_y = PanelBox.y;
                    this._updateStaticBox();
                    this._updateSettingsMouseSensitive();
                    // LayoutManager._updateBoxes() has just moved PanelBox
                    // back on screen: hide it again unless it is held.
                    this._handleMenus();
                }
            ],
            [
                this._intellihide,
                'status-changed',
                this._updatePreventHide.bind(this)
            ],
            [
                Main.layoutManager.uiGroup,
                'child-added',
                (group, actor) => {
                    if (actor.name === DASH_TO_DOCK_ACTOR_NAME)
                        this._trackDashToDockActor(actor);
                }
            ],
            [
                PanelBox,
                'notify::visible',
                () => {
                    if (!PanelBox.visible) {
                        this._panelVisible = false;
                        this._updateUnredirectState();
                    }
                }
            ]
        );

        Main.wm.addKeybinding("shortcut-keybind",
            this._settings, Meta.KeyBindingFlags.NONE,
            ShellActionMode.NORMAL,
            this._handleShortcut.bind(this)
        );

        this._updateIntellihideStatus();
    }

    _bindSettingsChanges() {
        this._signalsHandler = new Convenience.GlobalSignalsHandler();
        this._signalsHandler.addWithLabel("settings",
            [
                this._settings,
                'changed::hot-corner',
                this._updateSettingsHotCorner.bind(this)
            ],
            [
                this._settings,
                'changed::mouse-sensitive',
                this._updateSettingsMouseSensitive.bind(this)
            ],
            [
                this._settings,
                'changed::pressure-timeout',
                this._updateSettingsMouseSensitive.bind(this)
            ],
            [
                this._settings,
                'changed::pressure-threshold',
                this._updateSettingsMouseSensitive.bind(this)
            ],
            [
                this._settings,
                'changed::show-in-overview',
                this._updateSettingsShowInOverview.bind(this)
            ],
            [
                this._settings,
                'changed::enable-intellihide',
                this._updateIntellihideStatus.bind(this)
            ],
            [
                this._settings,
                'changed::enable-active-window',
                this._updateIntellihideStatus.bind(this)
            ]
        );
    }

    destroy() {
        if (this._bindTimeoutId) {
            GLib.source_remove(this._bindTimeoutId);
            this._bindTimeoutId = 0;
        }
        if (this._dashToDockRetryId) {
            GLib.source_remove(this._dashToDockRetryId);
            this._dashToDockRetryId = 0;
        }
        this._intellihide.destroy();
        for (const actor of [...this._dashToDockActors.keys()])
            this._untrackDashToDockActor(actor);
        for (const guardId of this._dashToDockGuardIds.values())
            GLib.source_remove(guardId);
        this._dashToDockGuardIds.clear();
        this._signalsHandler.destroy();
        Main.wm.removeKeybinding("shortcut-keybind");
        this._disablePressureBarrier();
        if (_searchEntryBin) {
          _searchEntryBin.style = null;
        }

        MessageTray._bannerBin.ease = this._oldEase;
        this.show(0, "destroy");
        this._setUnredirectDisabled(false);

        // The shell disables this extension while the screen is locked. Giving
        // the top bar its strut back then shrinks the work area and pushes
        // floating windows down.
        Main.layoutManager.removeChrome(PanelBox);
        Main.layoutManager.addChrome(PanelBox, {
            affectsStruts: Main.sessionMode.currentMode !== 'unlock-dialog',
            trackFullscreen: true
        });
        this._desktopIconsUsableArea.destroy();
        this._desktopIconsUsableArea = null;
    }
};
